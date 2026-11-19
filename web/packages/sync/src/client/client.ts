// The client half: a replica of what its user may read, one cursor token per
// log, an outbox in one global order, prediction and rebase, and reactive
// queries. It is replica-proto's `client.ts` made production-shaped, with
// the outbox driver of the mockup (`sxDrive`).
//
// The replica: each open log's records as the server last served them (the
// confirmed state), loaded from storage into the working set when the log is
// opened, and written back on each change. Queries read the working set
// through the overlay of pending writes. The stored replica belongs to one
// person: `init` writes the person into storage before any log is saved, and
// clears a stored state that names another person or names none.
//
// Reads: one read of a log at a time; a pull asked for while one is in
// flight runs once after it (`hydrate` waits its turn too). A read the server
// does not serve (`ReadError`) changes no log: UPDATE_REQUIRED holds the
// outbox, UNAUTHORIZED signs the client out (`signedOut`).
//
// Prediction: each pending write is applied with `@session/mutators` over
// the confirmed state and the writes before it (a `RecordSource` that
// answers UNKNOWN for what the replica cannot know, wrapped in `withOwnIds`
// with each mutation's derived ids cached). A write the mutators answer
// `unknown` stays pending without a prediction. On every change of the
// confirmed state (a pull, a snapshot, an answer's records) the overlay is
// rebuilt once: rolled back, the changes applied, the pending writes run
// again. An answered write stays in the overlay until every open log was read
// by a request made after its answer, so its effect does not flicker; the
// records an answer carries (STALE's `changes`) are not such a read.
//
// The outbox (AGENTS.md; the mockup's `sxDrive`):
// - one global order; a write gets its seq when it is sent (the last seq the
//   server processed + 1); what is on the wire is in storage first;
// - every envelope carries `clientTime` (the device's clock plus the offset
//   learned from CLOCK_SKEW, which is stored) and `queuedAt`;
// - a write's input ids are fixed once an envelope of it was sent: a copy of
//   that envelope may still apply. CLOCK_SKEW corrects the offset and gives
//   every queued write a new mutation id (the ids that were sent go to
//   `replaces`), and new input ids to the writes never sent (with every
//   write that names them changed to match). A sent write whose ids are
//   ahead of the corrected clock waits until they are within a minute. A
//   replayed answer whose result names another id than the input's (the
//   server applied an older envelope) moves the write and the writes after
//   it to the server's id;
// - TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR, no answer,
//   and CLOCK_SKEW or OUT_OF_ORDER that do not converge are a try: the
//   outbox pauses with backoff (1 s, doubled, at most 10 min); a `retryAt`
//   holds that write only (and the writes that name an id it names) until
//   then; after 5 tries the write is shown as failed and the outbox goes on.
//   A timer sends the outbox when the next wait ends;
// - EXPIRED is shown; a write still queued 3 days after `queuedAt` is dropped
//   and shown, by the server's time as learned from an answer this session;
// - UPDATE_REQUIRED holds the write and every write after it ("Update
//   Session"); UNAUTHORIZED, and WRONG_CLIENT that a new registration does
//   not cure, sign the client out (`signedOut`); OUT_OF_ORDER resends with
//   the server's expected seq; WRONG_CLIENT registers again;
// - Send again on a shown write: a new mutation id. A write the server
//   refused with a recorded answer (EXPIRED, a refusal) never applied: it is
//   sent as a new write, with new input ids and no `replaces` (listing the
//   refused id would replay the refusal). Any other keeps its input ids and
//   lists its sent ids in `replaces`, so a write the server applied under an
//   old id is answered from it and never applied twice;
// - online-only writes (a mutator marked `online`, and the `NOT_MUTATORS`
//   calls) are sent at once, never queued, predicted or stored.
// `persist: false` (the web): no wait across time: a write is sent at once,
// a transient failure ends it as failed (shown with Try again), and nothing
// is kept across a reload.
//
// Scope: a pull that answers resync takes a new snapshot of that log. A
// closed space whose snapshot shows its user is no longer a member becomes a
// frozen copy if they were removed: the user's own threads and what they
// wrote under them, never read again (they can still delete their threads
// there). A voluntary leave (this device's `spaces.leave`, or the user log's
// `ended: "left"`) keeps no copy. Joining again (a member record in the user
// log) brings the log back.
//
// Tiers: a tiered space log holds some threads as summaries (their thread
// and counts records only); a scan under such a thread is UNKNOWN. The
// summaries are the ones the server marks (`summaries`), and any thread
// whose records show it incomplete (an ask with no run, or fewer first-level
// follow-ups or replies held than its counts record says). A thread the
// person opened (`hydrate`) is reported in `tier.opened` for 14 days, so the
// server keeps serving it in full.
//
// Live updates: `listen` holds an event stream for the logs open now with a
// cursor; it reconnects when that set changes or a log gets a new cursor (the
// stream drops a log whose token stops opening, and the poke it sends makes
// the client pull, resync and reconnect). A poke pulls its open logs, then
// sends the outbox.

import * as pkg from "@session/mutators";

import {
  ID_MAX_AHEAD,
  MAX_REPLACES,
  MAX_TRIES,
  OPENED_TTL,
  OUTBOX_TTL,
  PROTOCOL_VERSION,
  RETRY_MAX,
  UNRECORDED,
  backoff,
  isReadError,
  type Answer,
  type AnswerError,
  type ApiError,
  type CallAnswer,
  type Change,
  type Cursor,
  type Envelope,
  type LogId,
  type MembershipEnd,
  type Pull,
  type ReadError,
  type ReadOptions,
  type Snapshot,
  type SseEvent,
  type StoredRecord,
  type TierOptions,
} from "../protocol.js";

import { makeQuery, type Changing, type Query } from "./query.js";
import { MemoryStorage, type ClientMeta, type StorageAdapter } from "./storage.js";
import { Offline, type CursorMap, type Transport } from "./transport.js";

export type EntryState =
  /** waiting to be sent, in order */
  | "queued"
  /** held by UPDATE_REQUIRED */
  | "held"
  /** applied by the server; kept in the overlay until its effects are pulled */
  | "answered"
  /** shown to the person: */
  | "failed"
  | "expired"
  | "dropped"
  | "refused";

export const SHOWN: ReadonlySet<EntryState> = new Set(["failed", "expired", "dropped", "refused"]);
const PENDING: ReadonlySet<EntryState> = new Set(["queued", "held", "answered"]);

/** One write in the outbox (stored as JSON). */
export interface OutboxEntry {
  /** Never sent and never changed: the person's view follows it. */
  local: string;
  mutationId: string;
  name: string;
  input: unknown;
  /** When it was queued, in the server's time as the client estimates it. */
  queuedAt: number;
  /** The monotonic clock then (this process only): a CLOCK_SKEW sets
   * `queuedAt` again from it. */
  queuedMono?: number;
  /** The mutation ids it had before that were sent: a copy of any of them
   * may still reach the server. */
  replaces: string[];
  /** An envelope of it may have reached the server without a definite
   * answer. */
  uncertain: boolean;
  /** An envelope of it was sent: its input ids are fixed (Send again after a
   * recorded refusal starts it afresh). */
  sent: boolean;
  /** An envelope with the current mutation id was sent. */
  wire: boolean;
  tries: number;
  /** Not sent before this time (the client's estimate of the server's). */
  next: number;
  /** When the wait until `next` began: a clock that reads earlier went
   * back, and the write is sent. */
  waitFrom?: number;
  /** The wait is this write's own (a limit's `retryAt`): the writes after
   * it go on. */
  own?: boolean;
  state: EntryState;
  error?: ApiError;
  result?: unknown;
  /** The ids the client made for its input (`ids` of the mutator). */
  minted: string[];
  /** Online only: sent at once, never kept. */
  online?: boolean;
  /** The client's read tick when it was answered (this process only: set
   * again when the outbox is loaded). */
  answeredTick?: number;
  /** What the mutators predicted. */
  prediction?: "ok" | "refused" | "unknown";
  predictedError?: ApiError;
}

interface LiveLog {
  cursor: Cursor | null;
  records: Map<string, StoredRecord>;
  frozen: boolean;
  /** The read tick of the latest read that was served (stamped when it was
   * requested). */
  pulledTick: number;
  tier: TierOptions | undefined;
  /** Threads held as summaries: their follow-ups, replies and runs are not
   * held (a scan of them is UNKNOWN). */
  summaries: Set<string>;
  /** The threads the server marked as summaries (`summaries`). */
  marked: Set<string>;
  /** Reads run one at a time. */
  chain: Promise<void>;
  /** A pull asked for and not started yet: later asks join it. */
  queued: Promise<boolean> | null;
}

/** A read fetched and not yet applied. */
type Fetched = { log: LogId; l: LiveLog; tick: number } & (
  | { pull: Extract<Pull, { changes: Change[] }>; snapshot?: undefined }
  | { pull?: undefined; snapshot: Snapshot }
);

/** How a write is queued: the defaults are a new mutation id and the
 * client's time now. A write carried over from elsewhere (an outbox written
 * before this client, a screen of the mockup) gives its own. `send: false`
 * queues it without sending the outbox. */
export interface WriteOptions {
  mutationId?: string;
  queuedAt?: number;
  replaces?: string[];
  send?: boolean;
}

/** A timer the client sends its outbox with when a wait ends. */
export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ClientOptions {
  user: string;
  transport: Transport;
  storage?: StorageAdapter;
  clock?: { now(): number };
  /** The client's random source for ids: a number in [0, 1). */
  random?: () => number;
  registry?: pkg.Registry;
  /** The default tier of the space logs it opens. */
  tier?: TierOptions;
  /** False for the web: no outbox across time (see above). */
  persist?: boolean;
  /** The timer for the outbox's waits (default: `setTimeout`); null: none,
   * the caller sends the outbox (tests, the simulation). */
  timer?: Timer | null;
  /** A clock that never jumps (ms; default `performance.now`): the time
   * since the server last gave its time, for the 3-day drop. */
  monotonic?: () => number;
}

/** Index scans a replica can never answer whole: their records are read
 * by staff or by their person only, or span spaces. */
const PARTIAL_SCANS: ReadonlySet<pkg.IndexName> = new Set<pkg.IndexName>([
  "invite.code",
  "invite.sp",
  "request.sp",
  "ban.sp",
  "report.sp",
  "report.key",
  "run.u",
  "srcrep.sp",
  "invask.sp",
  "notif.sp",
  "source.nurl",
  "spacesrc.nurl",
  "spacesrc.src",
]);
/** Scans by thread, unknown for a thread held as a summary. */
const THREAD_SCANS: ReadonlySet<pkg.IndexName> = new Set<pkg.IndexName>([
  "followup.th",
  "followup.par",
  "reply.th",
  "reply.parent",
  "run.th",
  "rlike.th",
  "asksave.th",
]);
/** Scans by space, unknown when the space's log is not open. */
const SPACE_SCANS: ReadonlySet<pkg.IndexName> = new Set<pkg.IndexName>([
  "thread.s",
  "counts.s",
  "member.sp",
  "page.sp",
  "skill.sp",
  "hide.s",
  "spacesrc.sp",
]);
/** Kinds whose absence a replica cannot vouch for (staff-only or another
 * person's records). The actor's own ban is answered as absent: a client
 * does not know it is banned, and the server refuses. */
const PARTIAL_GETS: ReadonlySet<pkg.Kind> = new Set<pkg.Kind>(["invite", "report", "srcrep"]);

/** The envelopes kept in `sent` (tests). */
const SENT_KEPT = 1000;

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const uniq = (xs: readonly string[]) => [...new Set(xs)].slice(-MAX_REPLACES);

/** The record a client-made id is the id of, if any (`idOf`). */
const idOfRecord = (r: StoredRecord) => pkg.idOf(r);

/** Every string in a JSON value. */
function stringsOf(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

/** A JSON value with each string `map` names replaced. */
const remapValue = (v: unknown, map: ReadonlyMap<string, string>): unknown =>
  typeof v === "string"
    ? (map.get(v) ?? v)
    : Array.isArray(v)
      ? v.map((x) => remapValue(x, map))
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapValue(x, map)]))
        : v;

const defaultTimer: Timer = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms) as unknown as { unref?: () => void };
    h.unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
};

export class SyncClient implements Changing {
  readonly user: string;
  private readonly transport: Transport;
  private readonly storage: StorageAdapter;
  private readonly clock: { now(): number };
  private readonly random: () => number;
  private readonly registry: pkg.Registry;
  private readonly tier: TierOptions | undefined;
  private readonly keep: boolean;
  private readonly timer: Timer | null;
  private readonly monotonic: () => number;
  private meta: ClientMeta;
  private readonly logs = new Map<LogId, LiveLog>();
  private overlay = new Map<string, StoredRecord | null>();
  private entries: OutboxEntry[] = [];
  /** Online-only writes being sent (never stored or predicted). */
  private direct: OutboxEntry[] = [];
  private readonly derivedCache = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, ((a: Answer | null) => void)[]>();
  private readonly listeners = new Set<() => void>();
  private ver = 0;
  private tick = 0;
  private loading: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  /** A write (or Send again, Retry) came in during a flush: it runs again. */
  private again = false;
  private timerHandle: unknown = null;
  /** The server's time from the latest answer this session, and the
   * monotonic clock then. */
  private timeAt: { server: number; mono: number } | null = null;
  /** Closed spaces this person left (not removed from). */
  private readonly left = new Set<string>();
  /** The connection of `listen`, aborted to reconnect. */
  private stream: AbortController | null = null;
  private stopped = false;
  /** The server answered UPDATE_REQUIRED: nothing is sent until an update. */
  updateRequired = false;
  /** The server does not take this client's session or device token: nothing
   * is sent until `signedIn`. */
  signedOut = false;
  /** The latest envelopes sent (tests). */
  readonly sent: { local: string; mutationId: string; seq: number }[] = [];

  constructor(o: ClientOptions) {
    this.user = o.user;
    this.transport = o.transport;
    this.storage = o.storage ?? new MemoryStorage();
    this.clock = o.clock ?? { now: () => Date.now() };
    this.random = o.random ?? Math.random;
    this.registry = o.registry ?? pkg.MUTATORS;
    this.tier = o.tier;
    this.keep = o.persist ?? true;
    this.timer = o.timer === undefined ? defaultTimer : o.timer;
    const perf = (globalThis as { performance?: { now(): number } }).performance;
    this.monotonic = o.monotonic ?? (perf ? () => perf.now() : () => this.clock.now());
    this.meta = { user: o.user, clientId: null, lastSeq: 0, offset: 0 };
  }

  /** Load the stored meta and outbox (a client restored after a restart).
   * A stored state of another person, or of nobody, is discarded, and the
   * storage is marked as this person's. Runs once; `open` waits for it. */
  init(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load() {
    const m = await this.storage.loadMeta();
    if (m && m.user === this.user) this.meta = m;
    else if (m || (await this.storage.logs()).length || (await this.storage.loadOutbox()).length)
      await this.storage.clear();
    await this.storage.saveMeta(this.meta);
    this.entries = ((await this.storage.loadOutbox()) as OutboxEntry[])
      .filter((e) => e && typeof e.local === "string")
      .map((e) => {
        const { queuedMono, ...rest } = e;
        void queuedMono;
        return { ...rest, sent: e.sent ?? true, wire: e.wire ?? true };
      });
    for (const e of this.entries) {
      // a tick of this process: every log is read again before it leaves
      if (e.state === "answered") e.answeredTick = this.tick++;
      this.noteLeave(e);
    }
    this.rebase();
  }

  // ---- time and ids ----

  /** The client's estimate of the server's time. */
  now(): number {
    return this.clock.now() + this.meta.offset;
  }

  newId(): string {
    return pkg.ulid(this.now(), this.random);
  }

  get clientId() {
    return this.meta.clientId;
  }
  get offset() {
    return this.meta.offset;
  }

  /** An answer's `serverTime` (NaN when the transport made the answer up). */
  private seen(serverTime: number) {
    if (Number.isFinite(serverTime)) this.timeAt = { server: serverTime, mono: this.monotonic() };
  }

  /** The server's time, from the latest answer this session and the time
   * since on the monotonic clock (a device clock that jumps does not move
   * it); null before an answer. */
  private serverNow(): number | null {
    if (!this.timeAt) return null;
    return this.timeAt.server + Math.max(0, this.monotonic() - this.timeAt.mono);
  }

  // ---- change notification (queries) ----

  version() {
    return this.ver;
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    this.ver++;
    for (const l of [...this.listeners]) l();
  }

  /** A query over the view: see `query.ts`. */
  query<T>(fn: (view: View) => T): Query<T> {
    return makeQuery(this, () => this.view(), fn);
  }

  // ---- the view ----

  /** A record as the client holds it: the overlay of pending writes over the
   * confirmed state. */
  get(key: string): StoredRecord | undefined {
    if (this.overlay.has(key)) return this.overlay.get(key) ?? undefined;
    return this.confirmed(key);
  }

  /** A record of the confirmed state. */
  confirmed(key: string): StoredRecord | undefined {
    for (const l of this.logs.values()) {
      const r = l.records.get(key);
      if (r) return r;
    }
    return undefined;
  }

  /** Every key of the view. */
  keys(): Set<string> {
    const out = new Set<string>();
    for (const l of this.logs.values()) for (const k of l.records.keys()) out.add(k);
    for (const [k, v] of this.overlay) {
      if (v === null) out.delete(k);
      else out.add(k);
    }
    return out;
  }

  view(): View {
    return new View(this);
  }

  /** Whether the view's record at `key` comes from a pending write. */
  pendingAt(key: string): boolean {
    return this.overlay.has(key);
  }

  /** The confirmed records of one log (tests). */
  records(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.logs.get(log)?.records ?? new Map();
  }

  isFrozen(log: LogId): boolean {
    return this.logs.get(log)?.frozen ?? false;
  }

  /** The threads of a space log held as summaries. */
  summaries(log: LogId): ReadonlySet<string> {
    return this.logs.get(log)?.summaries ?? new Set();
  }

  openLogs(): LogId[] {
    return [...this.logs.keys()];
  }

  cursors(): CursorMap {
    const out: CursorMap = {};
    for (const [log, l] of this.logs) if (!l.frozen && l.cursor !== null) out[log] = l.cursor;
    return out;
  }

  // ---- the outbox, as the person sees it ----

  outbox(): readonly OutboxEntry[] {
    return this.entries;
  }

  /** The writes shown to the person: failed, expired, dropped or refused. */
  problems(): OutboxEntry[] {
    return this.entries.filter((e) => SHOWN.has(e.state));
  }

  // ---- reads ----

  /** The threads of `log` opened in the past 14 days. */
  private opened(log: LogId): string[] {
    const by = this.meta.opened?.[log];
    if (!by) return [];
    const since = this.now() - OPENED_TTL;
    return Object.entries(by).flatMap(([th, at]) => (at >= since ? [th] : []));
  }

  private readOptions(log: LogId, extra: ReadOptions = {}): ReadOptions {
    const tier = this.logs.get(log)?.tier ?? this.tier;
    const opened = [...(tier?.opened ?? []), ...this.opened(log)];
    return {
      ...(this.meta.clientId !== null ? { clientId: this.meta.clientId } : {}),
      ...(log.startsWith("space:") && tier
        ? { tier: opened.length ? { ...tier, opened: [...new Set(opened)] } : tier }
        : {}),
      ...extra,
    };
  }

  private learn(lastSeq: number | null) {
    if (lastSeq !== null && lastSeq > this.meta.lastSeq) this.meta.lastSeq = lastSeq;
  }

  private newLog(tier: TierOptions | undefined): LiveLog {
    return {
      cursor: null,
      records: new Map(),
      frozen: false,
      pulledTick: -1,
      tier,
      summaries: new Set(),
      marked: new Set(),
      chain: Promise.resolve(),
      queued: null,
    };
  }

  /** Bring a log into the working set: from storage when it is there, else a
   * snapshot. */
  async open(log: LogId, tier?: TierOptions): Promise<void> {
    await this.init();
    if (this.logs.has(log)) return;
    const stored = await this.storage.loadLog(log);
    if (this.logs.has(log)) return;
    const l = this.newLog(tier ?? (log.startsWith("space:") ? this.tier : undefined));
    this.logs.set(log, l);
    if (stored) {
      l.cursor = stored.cursor;
      l.records = new Map(stored.records);
      l.frozen = stored.frozen;
      l.summaries = this.summariesOf(log, l);
      this.restream();
      this.rebase();
      return;
    }
    await this.sync(log);
  }

  /** Take a log out of the working set (it stays in storage). */
  close(log: LogId) {
    if (!this.logs.delete(log)) return;
    this.restream();
    this.rebase();
  }

  /** Bring open logs up to date: a pull, or a snapshot the first time and
   * after a resync. Answers false when a read was not served (no answer, or
   * a `ReadError`). The view is rebuilt once, at the end. */
  async sync(...only: LogId[]): Promise<boolean> {
    const logs = only.length ? only : [...this.logs.keys()];
    let reached = true;
    try {
      if (!(await this.readAll(logs))) reached = false;
      // a frozen space the user is a member of again comes back; a frozen
      // copy of a space they left is not kept
      const me = this.logs.get(`user:${this.user}`);
      const back: LogId[] = [];
      for (const [log, l] of this.logs) {
        if (!l.frozen) continue;
        const sp = log.slice(6);
        if (!this.left.has(sp) && !this.member(me, sp)) continue;
        l.frozen = false;
        l.cursor = null;
        back.push(log);
      }
      if (back.length) {
        this.restream();
        if (!(await this.readAll(back))) reached = false;
      }
    } finally {
      this.settle();
    }
    return reached;
  }

  /** Run `op` after the reads of `ls` before it. */
  private serial<T>(ls: readonly LiveLog[], op: () => Promise<T>): Promise<T> {
    const run = Promise.all(ls.map((l) => l.chain)).then(op);
    for (const l of ls)
      l.chain = run.then(
        () => {},
        () => {},
      );
    return run;
  }

  /** Read logs: each after the read of it in flight (a log with a read
   * queued and not started joins that one). The logs are fetched one after
   * the other, then applied together, so the view never holds one log read
   * and another not. Answers false when a read was not served. */
  private readAll(logs: readonly LogId[]): Promise<boolean> {
    const mine: [LogId, LiveLog][] = [];
    const joined: Promise<boolean>[] = [];
    for (const log of new Set(logs)) {
      const l = this.logs.get(log);
      if (!l) continue;
      if (l.queued) joined.push(l.queued);
      else mine.push([log, l]);
    }
    if (mine.length) {
      const run: Promise<boolean> = this.serial(
        mine.map(([, l]) => l),
        () => {
          for (const [, l] of mine) if (l.queued === run) l.queued = null;
          return this.readBatch(mine);
        },
      );
      for (const [, l] of mine) l.queued = run;
      joined.push(run);
    }
    return Promise.all(joined).then((xs) => xs.every(Boolean));
  }

  private async readBatch(batch: readonly [LogId, LiveLog][]): Promise<boolean> {
    const got: Fetched[] = [];
    let served = true;
    try {
      for (const [log, l] of batch) {
        let f: Fetched | null | false;
        try {
          f = await this.fetch(log, l);
        } catch (e) {
          if (!(e instanceof Offline)) throw e;
          f = false;
        }
        if (f === false) served = false;
        else if (f) got.push(f);
      }
    } finally {
      // the user log first: a membership that ended by a leave keeps no
      // frozen copy
      got.sort((a, b) => Number(b.log.startsWith("user:")) - Number(a.log.startsWith("user:")));
      await Promise.all(got.map((f) => this.applyFetched(f)));
    }
    return served;
  }

  /** A read the server did not serve: no log changes. */
  private readFailed(r: ReadError): false {
    const code = r.error.code;
    if (code === "UPDATE_REQUIRED") this.hold();
    else if (code === "UNAUTHORIZED") this.signOut();
    return false;
  }

  /** Fetch one log: a pull, or a snapshot when it has no cursor or the pull
   * answers resync. Null: nothing to apply; false: not served. */
  private async fetch(log: LogId, l: LiveLog): Promise<Fetched | null | false> {
    if (l.frozen || this.logs.get(log) !== l) return null;
    // the tick at request time: an answer that arrived while this read was
    // in flight is not covered by it
    const tick = this.tick++;
    if (l.cursor !== null) {
      const p = await this.transport.pull(log, l.cursor, this.readOptions(log));
      if (isReadError(p)) return this.readFailed(p);
      this.seen(p.serverTime);
      if (!("resync" in p)) return { log, l, tick, pull: p };
    }
    const s = await this.transport.snapshot(log, this.readOptions(log));
    if (isReadError(s)) return this.readFailed(s);
    this.seen(s.serverTime);
    return { log, l, tick, snapshot: s };
  }

  /** Apply a fetched read to its log (synchronously; the storage write is
   * the promise). */
  private applyFetched(f: Fetched): Promise<void> {
    const { log, l, tick } = f;
    if (this.logs.get(log) !== l || l.frozen) return Promise.resolve();
    if (f.pull) {
      const p = f.pull;
      this.learn(p.lastSeq);
      if (p.summaries)
        this.mark(
          l,
          p.changes.flatMap((c) => (c.op === "put" ? [c.record] : [])),
          p.summaries,
        );
      if (log === `user:${this.user}`) this.noteMembers(p.changes, p.ended);
      return this.applyChanges(log, l, p.changes, p.cursor, tick);
    }
    const s = f.snapshot;
    this.learn(s.lastSeq);
    const records = new Map(s.records.map((x) => [x.key, x.record]));
    if (s.summaries) {
      l.marked = new Set();
      this.mark(l, [...records.values()], s.summaries);
    }
    if (log === `user:${this.user}`)
      this.noteMembers(
        s.records.map((x): Change => ({ key: x.key, op: "put", record: x.record })),
        s.ended,
      );
    const frozen =
      l.cursor !== null && !this.left.has(log.slice(6)) && this.freeze(log, l.records, records);
    l.cursor = s.cursor;
    l.pulledTick = Math.max(l.pulledTick, tick);
    if (frozen) {
      l.records = frozen;
      l.frozen = true;
    } else l.records = records;
    l.summaries = this.summariesOf(log, l);
    // a new cursor (or none, for a frozen copy): the event stream follows
    this.restream();
    return this.storage.saveLog(log, {
      cursor: l.cursor,
      frozen: l.frozen,
      replace: true,
      puts: [...l.records],
      dels: [],
    });
  }

  /** Take the server's summary marks for the threads of `records`. */
  private mark(l: LiveLog, records: readonly StoredRecord[], summaries: readonly string[]) {
    const marked = new Set(summaries);
    for (const r of records) {
      const th = r.kind === "thread" ? r.id : r.kind === "counts" ? r.th : null;
      if (th === null) continue;
      if (marked.has(th)) l.marked.add(th);
      else l.marked.delete(th);
    }
  }

  /** The threads of a tiered space log held as summaries: those the server
   * marked, and those whose records show them incomplete: an ask with no
   * run, or a thread holding fewer first-level follow-ups or replies than
   * its counts record says. */
  private summariesOf(log: LogId, l: LiveLog): Set<string> {
    const out = new Set<string>();
    if (!log.startsWith("space:") || !l.tier || l.tier.window === "full") return out;
    const firsts = new Map<string, number>();
    const runs = new Set<string>();
    for (const r of l.records.values()) {
      if ((r.kind === "followup" && r.par === null) || (r.kind === "reply" && r.parent === null))
        firsts.set(r.th, (firsts.get(r.th) ?? 0) + 1);
      else if (r.kind === "run") runs.add(r.th);
    }
    for (const r of l.records.values()) {
      if (r.kind !== "thread") continue;
      const c = l.records.get(pkg.countsKey(r.id));
      const want = c?.kind === "counts" ? c.r : 0;
      if (l.marked.has(r.id) || (r.k === "ask" && !runs.has(r.id)) || (firsts.get(r.id) ?? 0) < want)
        out.add(r.id);
    }
    return out;
  }

  /** Fetch one thread in full (a summary the person opened); it is reported
   * as opened in later reads for 14 days, also when this fetch was not
   * served (answered false: no answer, or a `ReadError`). */
  async hydrate(log: LogId, thread: string): Promise<boolean> {
    const l = this.logs.get(log);
    if (!l || l.frozen) return true;
    const opened = (this.meta.opened ??= {});
    (opened[log] ??= {})[thread] = Math.round(this.now());
    const since = this.now() - OPENED_TTL;
    for (const by of Object.values(opened))
      for (const [th, at] of Object.entries(by ?? {})) if (at < since) delete by?.[th];
    await this.storage.saveMeta(this.meta);
    const served = await this.serial([l], async () => {
      if (this.logs.get(log) !== l || l.frozen) return true;
      let s;
      try {
        s = await this.transport.snapshot(log, this.readOptions(log, { threads: [thread] }));
      } catch (e) {
        if (e instanceof Offline) return false;
        throw e;
      }
      if (isReadError(s)) return this.readFailed(s);
      this.seen(s.serverTime);
      if (this.logs.get(log) !== l || l.frozen) return true;
      const puts = s.records.map((x): [string, StoredRecord] => [x.key, x.record]);
      for (const [k, r] of puts) l.records.set(k, r);
      l.marked.delete(thread);
      l.summaries = this.summariesOf(log, l);
      await this.storage.saveLog(log, { cursor: l.cursor, puts, dels: [] });
      return true;
    });
    this.rebase();
    return served;
  }

  /** After a resync of a closed space the user is no longer a member of:
   * their own threads and what they wrote under them, or null. */
  private freeze(log: LogId, before: Map<string, StoredRecord>, after: Map<string, StoredRecord>) {
    if (!log.startsWith("space:")) return null;
    const sp = log.slice(6);
    const space = after.get(pkg.spaceKey(sp));
    if (space?.kind !== "space" || !pkg.isClosed(space) || after.has(pkg.memberKey(sp, this.user)))
      return null;
    const mine = new Set(
      [...before.values()].flatMap((x) => (x.kind === "thread" && x.u === this.user ? [x.id] : [])),
    );
    const out = new Map<string, StoredRecord>();
    for (const [k, x] of after) out.set(k, x);
    for (const [k, x] of before) {
      const th =
        x.kind === "thread"
          ? x.id
          : x.kind === "followup" || x.kind === "reply" || x.kind === "run"
            ? x.th
            : null;
      if (th === null || !mine.has(th) || !("u" in x) || x.u !== this.user) continue;
      out.set(k, x);
    }
    return out;
  }

  /** How this user's memberships stand, from a read of their user log: a
   * member record is a membership; `ended`, or a `del` of the member key
   * with `ended`, says how one ended. */
  private noteMembers(
    changes: readonly Change[],
    ended: Readonly<Record<string, MembershipEnd>> | undefined,
  ) {
    const set = (sp: string, how: MembershipEnd | undefined) => {
      if (how === "left") this.left.add(sp);
      else this.left.delete(sp);
    };
    for (const c of changes) {
      const sp = this.memberSpace(c.key);
      if (sp !== null) set(sp, c.op === "del" ? c.ended : undefined);
    }
    for (const [sp, how] of Object.entries(ended ?? {})) set(sp, how);
  }

  /** Whether the user log holds a membership of `sp`. */
  private member(me: LiveLog | undefined, sp: string): boolean {
    return me?.records.has(pkg.memberKey(sp, this.user)) ?? false;
  }

  /** The space of this user's member key, or null. */
  private memberSpace(key: string): string | null {
    const m = /^member:([^:]+):(.+)$/.exec(key);
    return m && m[2] === this.user ? (m[1] ?? null) : null;
  }

  /** This device's answered `spaces.leave`: a voluntary leave. */
  private noteLeave(e: OutboxEntry) {
    if (e.state !== "answered" || e.name !== "spaces.leave") return;
    const sp = (e.input as { space?: unknown } | null)?.space;
    if (typeof sp === "string") this.left.add(sp);
  }

  /** Apply changes the server served for a log; `tick`: the read's request
   * tick (null: the records an answer carried, which are not a read). */
  private async applyChanges(
    log: LogId,
    l: LiveLog,
    changes: readonly Change[],
    cursor: Cursor | null,
    tick: number | null,
  ) {
    const puts: [string, StoredRecord][] = [];
    const dels: string[] = [];
    for (const c of changes) {
      if (c.op === "put") {
        l.records.set(c.key, c.record);
        puts.push([c.key, c.record]);
      } else {
        l.records.delete(c.key);
        dels.push(c.key);
      }
    }
    if (cursor !== null) l.cursor = cursor;
    if (tick !== null) l.pulledTick = Math.max(l.pulledTick, tick);
    l.summaries = this.summariesOf(log, l);
    await this.storage.saveLog(log, { cursor: l.cursor, puts, dels });
  }

  /** Records an answer carried (STALE's `changes`): applied to every open
   * log that holds the key, or to the log its kind is in. */
  private async applyAnswerChanges(changes: readonly Change[] | undefined) {
    if (!changes?.length) return;
    for (const [log, l] of this.logs) {
      if (l.frozen) continue;
      const mine = changes.filter(
        (c) => l.records.has(c.key) || (c.op === "put" && pkg.logsOf(c.record).includes(log)),
      );
      if (mine.length) await this.applyChanges(log, l, mine, null, null);
    }
  }

  /** Drop the answered writes every open log has been read after, then
   * rebuild the overlay. */
  private settle() {
    // a shown write that went without an answer and whose record arrived
    // applied after all
    const shown = this.entries.filter((e) => SHOWN.has(e.state) && e.uncertain);
    if (shown.length) {
      const ids = this.confirmedIds();
      for (const e of shown)
        if (this.appliedHere(e, ids)) {
          e.state = "answered";
          e.answeredTick = this.tick++;
          delete e.error;
        }
    }
    const live = [...this.logs.values()].filter((l) => !l.frozen);
    const oldest = live.length ? Math.min(...live.map((l) => l.pulledTick)) : Infinity;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.state !== "answered" || (e.answeredTick ?? Infinity) >= oldest,
    );
    if (this.entries.length !== before) void this.persist();
    const pending = new Set(this.entries.flatMap((e) => (PENDING.has(e.state) ? [e.mutationId] : [])));
    for (const m of this.derivedCache.keys()) if (!pending.has(m)) this.derivedCache.delete(m);
    this.rebase();
  }

  // ---- prediction and rebase ----

  /** Whether a pending write's derived ids include `id` (cached per
   * mutation: MAX_DERIVED hashes once, not on every check). */
  private derived(id: string): boolean {
    const time = id.slice(0, 10);
    for (const e of this.entries) {
      if (!PENDING.has(e.state) || e.mutationId.slice(0, 10) !== time) continue;
      let set = this.derivedCache.get(e.mutationId);
      if (!set)
        this.derivedCache.set(e.mutationId, (set = pkg.derivedIds(this.user, e.mutationId)));
      if (set.has(id)) return true;
    }
    return false;
  }

  /** The ids of the confirmed records (the part of the id registry a
   * replica holds). */
  private confirmedIds(): Set<string> {
    const out = new Set<string>();
    for (const l of this.logs.values())
      for (const r of l.records.values()) {
        const id = idOfRecord(r);
        if (id !== null) out.add(id);
      }
    return out;
  }

  private source(confirmedIds: ReadonlySet<string>): pkg.RecordSource {
    const hasLog = (log: LogId) => {
      const l = this.logs.get(log);
      return l !== undefined && !l.frozen;
    };
    const inner: pkg.RecordSource = {
      get: (kind, id) => {
        const key = pkg.keyFor(kind, id);
        const r = this.get(key);
        if (r) return r.kind === kind ? r : undefined;
        if (this.overlay.has(key)) return undefined;
        if (PARTIAL_GETS.has(kind)) return pkg.UNKNOWN;
        // a person's own records are in their user log: unknown while it is
        // not open
        if (pkg.NO_SPACE_LOG.has(kind) && kind !== "source" && !hasLog(`user:${this.user}`))
          return pkg.UNKNOWN;
        if ((kind === "request" || kind === "invask") && !id.includes(this.user))
          return pkg.UNKNOWN;
        return undefined;
      },
      scan: (index, value) => {
        if (PARTIAL_SCANS.has(index)) return pkg.UNKNOWN;
        if (SPACE_SCANS.has(index) && !hasLog(`space:${value}`)) return pkg.UNKNOWN;
        if (THREAD_SCANS.has(index)) {
          const th =
            index === "followup.par" || index === "reply.parent" ? this.threadOfItem(value) : value;
          if (th === null) return pkg.UNKNOWN;
          for (const l of this.logs.values()) if (l.summaries.has(th)) return pkg.UNKNOWN;
        }
        const out: StoredRecord[] = [];
        for (const key of this.keys()) {
          const r = this.get(key);
          if (r && pkg.inIndex(r, index, value)) out.push(r);
        }
        return out;
      },
      idUsed: (id) => {
        if (confirmedIds.has(id)) return true;
        for (const v of this.overlay.values()) if (v && idOfRecord(v) === id) return true;
        return pkg.UNKNOWN;
      },
    };
    const minted = new Set<string>();
    const mutations = new Set<string>();
    for (const e of this.entries)
      if (PENDING.has(e.state)) {
        for (const id of e.minted) minted.add(id);
        mutations.add(e.mutationId);
      }
    return pkg.withOwnIds(inner, {
      user: this.user,
      minted,
      mutations,
      derived: (id) => this.derived(id),
    });
  }

  private threadOfItem(id: string): string | null {
    const f = this.get(`followup:${id}`) ?? this.get(`reply:${id}`);
    return f && "th" in f ? (f as { th: string }).th : null;
  }

  /** Rebuild the overlay: the pending writes, in order, over the confirmed
   * state. */
  private rebase() {
    this.overlay = new Map();
    const now = this.now();
    const ids = this.confirmedIds();
    for (const e of this.entries) {
      if (!PENDING.has(e.state)) continue;
      const out = pkg.apply(
        this.registry,
        this.source(ids),
        { u: this.user },
        { mutationId: e.mutationId, name: e.name, input: e.input, clientTime: now },
        { now },
      );
      e.prediction = out.status;
      if (out.status === "refused") e.predictedError = out.error;
      else delete e.predictedError;
      if (out.status !== "ok") continue;
      for (const [key, draft] of out.writes) {
        if (draft === null) {
          this.overlay.set(key, null);
          continue;
        }
        const rev = (this.get(key)?.rev ?? 0) + 1;
        this.overlay.set(key, { ...draft, rev });
      }
    }
    this.changed();
  }

  // ---- writes ----

  /** Queue a write, predict it, and send the outbox. Answers its local id
   * and a promise of the server's answer (null: it ended without one: shown,
   * or dropped). An online-only write is sent at once and never queued. */
  write(
    name: string,
    input: unknown,
    o: WriteOptions = {},
  ): { local: string; answer: Promise<Answer | null> } {
    const local = pkg.ulid(this.now(), this.random);
    if (Object.hasOwn(pkg.NOT_MUTATORS, name)) {
      const answer = this.call(name, input).then(
        (a): Answer => a,
        (e: unknown) => {
          if (e instanceof Offline) return null;
          throw e;
        },
      );
      return { local, answer };
    }
    const def = this.registry.get(name);
    const parsed = def?.input.safeParse(input);
    const minted = parsed?.success && def ? def.ids(parsed.data) : [];
    const now = this.now();
    const queuedAt = Math.round(o.queuedAt ?? now);
    const e: OutboxEntry = {
      local,
      mutationId: o.mutationId ?? this.newId(),
      name,
      input: json(input),
      queuedAt,
      queuedMono: this.monotonic() - (now - queuedAt),
      replaces: [...(o.replaces ?? [])],
      uncertain: false,
      sent: false,
      wire: false,
      tries: 0,
      next: 0,
      state: "queued",
      minted,
      ...(def?.online ? { online: true } : {}),
    };
    const answer = new Promise<Answer | null>((resolve) => {
      this.waiters.set(e.local, [...(this.waiters.get(e.local) ?? []), resolve]);
    });
    if (e.online) {
      this.direct.push(e);
      void this.flush();
      return { local, answer };
    }
    this.entries.push(e);
    void this.persist();
    this.rebase();
    if (o.send !== false) void this.flush();
    return { local, answer };
  }

  /** An online-only call (`NOT_MUTATORS`): sent now, never queued. */
  call(name: string, input: unknown): Promise<CallAnswer> {
    return this.transport.call(name, input);
  }

  private resolve(e: OutboxEntry, a: Answer | null) {
    const ws = this.waiters.get(e.local);
    this.waiters.delete(e.local);
    for (const w of ws ?? []) w(a);
  }

  private async persist() {
    if (this.keep)
      await this.storage.saveOutbox(
        // what holds for this process only is not stored
        this.entries.map((e) => {
          const { answeredTick, queuedMono, prediction, predictedError, ...rest } = e;
          void answeredTick;
          void queuedMono;
          void prediction;
          void predictedError;
          return rest;
        }),
      );
    await this.storage.saveMeta(this.meta);
  }

  /** Take a shown write out of the list, or cancel a queued one. */
  discard(local: string): boolean {
    const k = this.entries.findIndex((e) => e.local === local && e.state !== "answered");
    if (k < 0) return false;
    const [e] = this.entries.splice(k, 1);
    if (e) this.resolve(e, null);
    void this.persist();
    this.rebase();
    return true;
  }

  /** Whether the confirmed state holds a record with an id `e` made: an
   * envelope of it applied (only this client makes its ids). */
  private appliedHere(e: OutboxEntry, ids = this.confirmedIds()): boolean {
    return e.sent && e.minted.some((id) => ids.has(id));
  }

  /** New input ids for `e` (its ids were never used on the server), with
   * the writes after it that name them changed to match. */
  private freshIds(e: OutboxEntry) {
    const map = new Map(e.minted.map((id) => [id, this.newId()]));
    this.remap(map, [e]);
  }

  /** Replace ids in the inputs of `own` and of every queued write never
   * sent (a sent write's input is fixed). */
  private remap(map: ReadonlyMap<string, string>, own: readonly OutboxEntry[] = []) {
    if (!map.size) return;
    for (const e of [...this.direct, ...this.entries]) {
      if (!own.includes(e) && (e.sent || e.state !== "queued")) continue;
      e.input = remapValue(e.input, map);
      e.minted = e.minted.map((id) => map.get(id) ?? id);
    }
  }

  /** Send a shown write again with a new mutation id.
   * - A write whose made ids the replica holds applied: it is answered.
   * - One never sent, or one the server refused with a recorded answer
   *   (EXPIRED, a refusal) that never went without an answer, never
   *   applied: it goes as a new write, with new input ids.
   * - Any other keeps its input ids (a create that applied under an
   *   envelope whose answer is gone answers CONFLICT, not a second copy),
   *   and a failed or dropped one lists its sent ids in `replaces`, so a
   *   write the server applied under an old id is answered from it.
   * A recorded refusal is never listed: it would be replayed. */
  sendAgain(local: string): boolean {
    const e = this.entries.find((x) => x.local === local && SHOWN.has(x.state));
    if (!e) return false;
    const refused = e.state === "expired" || e.state === "refused";
    if (this.appliedHere(e)) {
      e.state = "answered";
      e.answeredTick = this.tick++;
      delete e.error;
      void this.persist();
      this.rebase();
      return true;
    }
    if (!e.sent || (refused && !e.uncertain)) {
      e.replaces = [];
      e.sent = false;
      e.uncertain = false;
      this.freshIds(e);
    } else if (refused) e.replaces = [];
    else if (e.wire) e.replaces = uniq([...e.replaces, e.mutationId]);
    e.mutationId = this.newId();
    e.wire = false;
    e.queuedAt = Math.round(this.now());
    e.queuedMono = this.monotonic();
    e.tries = 0;
    e.next = 0;
    delete e.waitFrom;
    delete e.own;
    e.state = "queued";
    delete e.error;
    void this.persist();
    this.rebase();
    void this.flush();
    return true;
  }

  /** "Retry now": a waiting write is sent now. */
  retryNow() {
    for (const e of this.entries)
      if (e.state === "queued") {
        e.next = 0;
        delete e.waitFrom;
      }
    return this.flush();
  }

  /** After an update: the held writes are sent again. */
  updated() {
    this.updateRequired = false;
    for (const e of this.entries) if (e.state === "held") e.state = "queued";
    return this.flush();
  }

  /** After the person signed in again (a new session or device token). */
  signedIn() {
    this.signedOut = false;
    this.changed();
    return this.flush();
  }

  private async register(): Promise<boolean> {
    if (this.meta.clientId !== null) return true;
    let r;
    try {
      r = await this.transport.register();
    } catch (e) {
      if (e instanceof Offline) return false;
      throw e;
    }
    this.seen(r.serverTime);
    if (!r.ok) {
      if (r.error.code === "UPDATE_REQUIRED") this.hold();
      else if (r.error.code === "UNAUTHORIZED") this.signOut();
      return false;
    }
    this.meta.clientId = r.clientId;
    this.meta.lastSeq = 0;
    await this.persist();
    return true;
  }

  private hold() {
    if (!this.updateRequired) {
      this.updateRequired = true;
      this.changed();
    }
    for (const e of this.entries) if (e.state === "queued") e.state = "held";
  }

  private signOut() {
    if (this.signedOut) return;
    this.signedOut = true;
    this.changed();
  }

  /** A write still queued 3 days after it was queued (server time, as an
   * answer this session gave it) is dropped and shown, never sent. */
  private expire() {
    const now = this.serverNow();
    if (now === null) return;
    for (const e of this.entries)
      if (e.state === "queued" && now - e.queuedAt >= OUTBOX_TTL) this.end(e, "dropped");
  }

  private end(e: OutboxEntry, state: EntryState, error?: ApiError, a: Answer | null = null) {
    e.state = state;
    if (error) e.error = error;
    // online only: never kept
    if (e.online) this.direct = this.direct.filter((x) => x !== e);
    this.resolve(e, a);
  }

  /** CLOCK_SKEW: the offset is corrected, every queued write gets a new
   * mutation id (one that was sent goes to `replaces`) and `queuedAt` on the
   * corrected clock (from the monotonic clock when it was queued in this
   * process; else at most now), and the writes never sent get new input ids. */
  private reclock(serverTime: number) {
    this.meta.offset = serverTime - this.clock.now();
    const now = Math.round(this.now());
    const mono = this.monotonic();
    const map = new Map<string, string>();
    for (const e of [...this.direct, ...this.entries]) {
      if (e.state !== "queued") continue;
      if (e.wire) e.replaces = uniq([...e.replaces, e.mutationId]);
      e.mutationId = this.newId();
      e.wire = false;
      e.queuedAt =
        e.queuedMono !== undefined
          ? Math.min(now, Math.round(now - (mono - e.queuedMono)))
          : Math.min(now, e.queuedAt);
      if (!e.sent) for (const id of e.minted) map.set(id, this.newId());
    }
    this.remap(map);
  }

  /** A replayed answer whose result names another id than the write's
   * input: the server applied an older envelope of it. The write and the
   * queued writes never sent take the server's id. */
  private adopt(e: OutboxEntry, result: unknown) {
    const id = (result as { id?: unknown } | null)?.id;
    const mine = e.minted[0];
    if (e.minted.length !== 1 || typeof id !== "string" || mine === undefined || id === mine)
      return;
    this.remap(new Map([[mine, id]]), [e]);
  }

  /** When `e`'s input ids (fixed once sent) are within a minute of the
   * server's clock: ids made by a device clock that was ahead wait. */
  private idsDue(e: OutboxEntry): number {
    if (!e.sent) return 0;
    let at = 0;
    for (const id of e.minted) if (pkg.isUlid(id)) at = Math.max(at, pkg.ulidTime(id));
    return at - ID_MAX_AHEAD;
  }

  /** When `e` may be sent: `next`, or now when the clock went back since
   * its wait began. */
  private dueAt(e: OutboxEntry, now: number): number {
    if (e.waitFrom !== undefined && now < e.waitFrom) return 0;
    return e.next;
  }

  /** The write to send next, or null: an online write first; then the first
   * queued write in order, unless it is waiting (a backoff pauses the
   * outbox; a write's own `retryAt` holds it, and the writes that name an id
   * it makes, which wait with it). */
  private pick(now = this.now()): OutboxEntry | null {
    const d = this.direct.find((e) => e.state === "queued");
    if (d) return d;
    if (this.updateRequired || this.signedOut) return null;
    const held = new Set<string>();
    for (const e of this.entries) {
      if (e.state !== "queued") continue;
      const due = this.dueAt(e, now) <= now;
      if ((e.own && !due) || (held.size > 0 && [...stringsOf(e.input)].some((x) => held.has(x)))) {
        for (const id of e.minted) held.add(id);
        continue;
      }
      return due ? e : null;
    }
    return null;
  }

  /** Send the outbox in order (one flush at a time; a write queued during a
   * flush is sent by it). */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    const run = async () => {
      try {
        for (;;) {
          this.again = false;
          const blocked = await this.flushOnce();
          if (blocked || !(this.again || this.pick() !== null)) break;
        }
      } finally {
        this.flushing = null;
        this.schedule();
      }
    };
    this.flushing = run();
    return this.flushing;
  }

  /** Set the timer for the earliest wait of a queued write. */
  private schedule() {
    if (!this.timer || this.stopped) return;
    if (this.timerHandle !== null) this.timer.clear(this.timerHandle);
    this.timerHandle = null;
    if (this.updateRequired || this.signedOut) return;
    // the earliest wait that ends (a write due now that was not sent is held
    // behind a wait)
    const now = this.now();
    let at = Infinity;
    for (const e of this.entries) {
      const d = this.dueAt(e, now);
      if (e.state === "queued" && d > now) at = Math.min(at, d);
    }
    if (!Number.isFinite(at)) return;
    // at most the longest backoff: a clock that jumped is looked at again
    this.timerHandle = this.timer.set(
      () => {
        this.timerHandle = null;
        void this.flush();
      },
      Math.min(RETRY_MAX, at - now),
    );
  }

  /** Stop the outbox's timer (the client is no longer used). */
  stop() {
    this.stopped = true;
    if (this.timer && this.timerHandle !== null) this.timer.clear(this.timerHandle);
    this.timerHandle = null;
    this.stream?.abort();
  }

  /** Online writes cannot wait: held or signed out, they fail at once. */
  private failDirect() {
    if (!this.updateRequired && !this.signedOut) return;
    for (const e of [...this.direct])
      this.end(e, "failed", {
        code: this.updateRequired ? "UPDATE_REQUIRED" : "UNAUTHORIZED",
        message: this.updateRequired ? "Update Session." : "Sign in again.",
      });
  }

  /** One pass over the outbox. Answers whether it is blocked (no server,
   * held, signed out), so the flush does not go round again. */
  private async flushOnce(): Promise<boolean> {
    this.expire();
    if (this.updateRequired) this.hold();
    this.failDirect();
    let blocked = false;
    if (this.pick() === null) {
      // nothing to send now
    } else if (!(await this.register())) blocked = true;
    else {
      let skews = 0;
      let gaps = 0;
      let fresh = 0;
      for (;;) {
        this.expire();
        this.failDirect();
        const now = this.now();
        const e = this.pick(now);
        if (!e) break;
        // ids a device clock made ahead of the server's: the outbox waits
        // until they are within a minute, for at most 10 minutes. Ids
        // further ahead are sent: the server's EXPIRED is recorded under
        // every id the write had, so no copy of it applies later, and Send
        // again starts it afresh
        const ids = this.idsDue(e);
        if (ids > now && ids - now <= RETRY_MAX && !e.online) {
          e.next = ids;
          e.waitFrom = now;
          e.own = false;
          break;
        }
        const env: Envelope = {
          clientId: this.meta.clientId ?? "",
          seq: this.meta.lastSeq + 1,
          mutationId: e.mutationId,
          name: e.name,
          input: e.input,
          protocolVersion: PROTOCOL_VERSION,
          clientTime: Math.max(0, Math.round(now)),
          queuedAt: e.queuedAt,
          replaces: e.replaces,
        };
        e.sent = true;
        e.wire = true;
        // what goes on the wire is in storage first (a remint, `uncertain`)
        if (!e.online) await this.persist();
        this.sent.push({ local: e.local, mutationId: e.mutationId, seq: env.seq });
        if (this.sent.length > SENT_KEPT) this.sent.splice(0, this.sent.length - SENT_KEPT);
        const [a] = await this.transport.push([env]);
        if (!a) {
          // no answer: it may have been applied
          e.uncertain = true;
          if (this.transient(e, now, undefined)) continue;
          break;
        }
        this.seen(a.serverTime);
        if (!a.ok) {
          const code = a.error.code;
          if (code === "CLOCK_SKEW" && skews++ < 3) {
            this.reclock(a.serverTime);
            continue;
          }
          if (code === "OUT_OF_ORDER" && a.error.expectedSeq !== undefined && gaps++ < 3) {
            this.meta.lastSeq = a.error.expectedSeq - 1;
            continue;
          }
          if (code === "WRONG_CLIENT" && fresh++ < 1) {
            this.meta.clientId = null;
            if (await this.register()) continue;
            blocked = true;
            break;
          }
          if (code === "UNAUTHORIZED" || code === "WRONG_CLIENT") {
            this.signOut();
            this.failDirect();
            blocked = true;
            break;
          }
          if (code === "UPDATE_REQUIRED") {
            this.hold();
            this.failDirect();
            blocked = true;
            break;
          }
          if (code === "TOO_LARGE") {
            this.end(e, "failed", a.error, a);
            continue;
          }
          // transient, and CLOCK_SKEW or OUT_OF_ORDER that did not converge
          if (UNRECORDED.has(code)) {
            if (this.transient(e, now, a.error)) continue;
            break;
          }
        }
        // recorded (or replayed): applied or refused
        if (a.seq !== undefined) this.meta.lastSeq = Math.max(this.meta.lastSeq, a.seq);
        skews = 0;
        gaps = 0;
        if (a.ok) {
          if (a.replayed) this.adopt(e, a.result);
          if (e.online) this.direct = this.direct.filter((x) => x !== e);
          e.state = "answered";
          e.result = a.result;
          e.answeredTick = this.tick++;
          if (e.name === "threads.delete") this.unfreeze((e.input as { id: string }).id);
          this.noteLeave(e);
          this.resolve(e, a);
        } else {
          await this.applyAnswerChanges(a.error.changes);
          // the recorded answer covers every id it had: none can apply
          e.replaces = [];
          this.end(e, a.error.code === "EXPIRED" ? "expired" : "refused", a.error, a);
        }
        this.rebase();
      }
    }
    await this.persist();
    this.rebase();
    return blocked;
  }

  /** A try that failed (a transient answer, or none): wait the backoff, or
   * the answer's `retryAt` (this write only), or after 5 tries (online only
   * or on the web: at once) show it as failed. Answers whether the flush
   * goes on. */
  private transient(e: OutboxEntry, now: number, error: AnswerError | undefined): boolean {
    e.tries++;
    if (e.online || !this.keep || e.tries >= MAX_TRIES) {
      this.end(
        e,
        "failed",
        error ?? { code: "SERVICE_UNAVAILABLE", message: "No answer from the server." },
      );
      return true;
    }
    const at = error?.retryAt ? pkg.msOf(error.retryAt) : NaN;
    e.own = Number.isFinite(at);
    e.next = e.own ? at : now + backoff(e.tries);
    e.waitFrom = now;
    return e.own;
  }

  /** The person deleted a thread: drop it from any frozen copy. */
  private unfreeze(thread: string) {
    for (const [log, l] of this.logs) {
      if (!l.frozen) continue;
      const dels: string[] = [];
      for (const [k, x] of l.records) {
        const th = x.kind === "thread" ? x.id : "th" in x ? (x as { th: string }).th : null;
        if (th === thread) {
          l.records.delete(k);
          dels.push(k);
        }
      }
      if (dels.length) void this.storage.saveLog(log, { cursor: l.cursor, puts: [], dels });
    }
  }

  // ---- live updates ----

  /** Reconnect `listen`'s stream (the logs it is for changed). */
  private restream() {
    this.stream?.abort();
  }

  /** Listen for pokes until `signal` aborts: each poke pulls its open logs,
   * then the outbox is sent (an answer that arrived as a change). The
   * stream reconnects when the open logs or their cursors change. */
  async listen(signal: AbortSignal): Promise<void> {
    const onEvent = (e: SseEvent) => {
      if (e.type !== "poke") return;
      const logs = e.logs.filter((l) => this.logs.has(l));
      if (!logs.length) return;
      void this.sync(...logs)
        .then(() => this.flush())
        .catch(() => {
          // a failed read is retried by the next poke or sync
        });
    };
    while (!signal.aborted && !this.stopped) {
      const conn = new AbortController();
      const stop = () => conn.abort();
      signal.addEventListener("abort", stop);
      this.stream = conn;
      try {
        await this.transport.listen(() => this.cursors(), onEvent, conn.signal);
      } finally {
        signal.removeEventListener("abort", stop);
        if (this.stream === conn) this.stream = null;
      }
      // the stream ended by itself: done
      if (!conn.signal.aborted) return;
    }
  }
}

/** What a query reads: the client's view (confirmed state and pending
 * writes) and the per-viewer fields of `@session/mutators`' `viewer`. */
export class View implements pkg.Reader {
  constructor(private readonly c: SyncClient) {}

  get me() {
    return this.c.user;
  }

  get<K extends pkg.Kind>(kind: K, id: string): pkg.RecordOf<K> | undefined {
    const r = this.c.get(pkg.keyFor(kind, id));
    return r?.kind === kind ? (r as pkg.RecordOf<K>) : undefined;
  }

  byKey(key: string): StoredRecord | undefined {
    return this.c.get(key);
  }

  /** The records of a kind, by the server's creation time. */
  list<K extends pkg.Kind>(kind: K, pred?: (r: pkg.RecordOf<K>) => boolean): pkg.RecordOf<K>[] {
    const out: pkg.RecordOf<K>[] = [];
    for (const key of this.c.keys()) {
      if (!key.startsWith(`${kind}:`)) continue;
      const r = this.c.get(key);
      if (r?.kind === kind && (!pred || pred(r as pkg.RecordOf<K>))) out.push(r as pkg.RecordOf<K>);
    }
    return out.sort((a, b) => {
      const x = pkg.createdOf(a);
      const y = pkg.createdOf(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  /** Whether the record at `key` shows a pending write. */
  pending(key: string): boolean {
    return this.c.pendingAt(key);
  }
}
