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
// flight runs once after it (`hydrate` waits its turn too). Every read
// carries the client id (the client registers before its first read). A
// read the server does not serve (`ReadError`) changes no log:
// UPDATE_REQUIRED holds the outbox, UNAUTHORIZED signs the client out
// (`signedOut`). A served read with `lastSeq: null` was made as nobody, or as
// another person (a session that ended): it is taken as UNAUTHORIZED and the
// client id is forgotten (`signedIn` registers a new one). Once signed out,
// the rest of a batch of reads is not sent, and no read is until `signedIn`.
//
// Time: the client's time is the device's clock plus an offset, stored. The
// first answer of a process sets the offset when the two differ by more than
// a minute, and CLOCK_SKEW corrects it later. The 3-day drop and the age of a
// never-sent id are measured against the server's time as an answer this
// session gave it, plus a monotonic clock since.
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
// - every envelope carries `clientTime` (the client's time) and `queuedAt`;
// - a write's input ids are fixed once an envelope of it was sent, and its
//   mutation id once that id was on the wire: a copy of that envelope may
//   still apply. Before a write is sent, a mutation id never on the wire and
//   input ids never sent that are more than a minute ahead of the server's
//   time are made again. After CLOCK_SKEW a mutation id that was on the wire
//   gets a new one (the old one in `replaces`) only when the corrected clock
//   puts it more than 4 days back or more than 10 minutes ahead; a write
//   that went without an answer keeps it. A sent write whose ids are ahead
//   waits until they are within a minute (at most 10 minutes; on the web it
//   ends with Try again). The ids a mutator derives (`deriveId(user,
//   mutation id, k)`) change with the mutation id: when it changes, the
//   writes whose inputs may change (never sent, or refused with a recorded
//   answer) and name a derived id of the old one name the new one's. A
//   replayed answer is the one recorded under `recordedAs`: the write takes
//   that mutation id (and the writes after it its derived ids), and a result
//   that names another id than the input's moves the write and the writes
//   after it to the server's id;
// - a request at the moment the process ends may have applied: an entry
//   stored on the wire loads as uncertain. CONFLICT on an id the write's own
//   input makes (`ID_TAKEN`), for a write sent before, means an earlier
//   envelope applied (only this client makes those ids): it is answered.
//   The server answers that CONFLICT in place of EXPIRED, so EXPIRED of a
//   write whose input makes ids means none of them exists: no envelope
//   applied, and Send again may use new ids (a server before review round 2
//   answered EXPIRED either way);
// - TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR, a
//   response that is not an answer, and CLOCK_SKEW or OUT_OF_ORDER that do
//   not converge are a try: the outbox pauses with backoff (1 s, doubled, at
//   most 10 min); a `retryAt` holds that write only (and the writes that name
//   an id it names) until then; after 5 tries the write is shown as failed
//   and the outbox goes on. No response at all (offline) is not a try: the
//   outbox pauses with the same backoff over the requests in a row that got
//   none, the write is uncertain, the next answer from the server ends the
//   wait, and the 3-day drop ends the write. A timer sends the outbox when
//   the next wait ends;
// - EXPIRED is shown; a write still queued 3 days after it was queued is
//   dropped and shown (by the monotonic clock for a write of this process,
//   else by the server's time against `queuedAt`);
// - UPDATE_REQUIRED holds the write and every write after it ("Update
//   Session"), for this process (the next process sends them, and the server
//   says so again if it is still too old); UNAUTHORIZED, and WRONG_CLIENT
//   that a new registration does not cure, sign the client out
//   (`signedOut`); OUT_OF_ORDER resends with the server's expected seq;
//   WRONG_CLIENT registers again;
// - Send again on a shown write: a new mutation id. A write the server
//   refused with a recorded answer (EXPIRED, a refusal) that never went
//   without an answer never applied: it is sent as a new write, with new
//   input ids and no `replaces` (listing the refused id would replay the
//   refusal). Any other keeps its input ids and lists its sent ids in
//   `replaces`, so a write the server applied under an old id is answered
//   from it and never applied twice. Send again may carry a new input
//   that makes the same ids (a create's text edited after its answer was
//   lost): it is still the one write. Discard of a write on the wire is
//   refused;
// - online-only writes (a mutator marked `online`, and the `NOT_MUTATORS`
//   calls) are sent at once, never queued, predicted or stored; held, signed
//   out, or when a flush ends blocked (offline, a registration the server
//   refused), they fail.
// `persist: false` (the web): no wait across time: a write is sent at once,
// a transient failure, no response, ids ahead, or a sign-out ends it as
// failed (shown with Try again), and nothing is kept across a reload.
//
// Scope: a pull that answers resync takes a new snapshot of that log. A
// closed space whose snapshot shows its user is no longer a member becomes a
// frozen copy if they were removed: the user's own threads and what they
// wrote under them, never read again (they can still delete their threads
// there). A voluntary leave (this device's `spaces.leave`, or the user log's
// `ended: "left"`) keeps no copy. Joining again (a member record in the user
// log) brings the log back.
//
// Tiers: space logs are read with the `desktop` window unless the client is
// made with another. A tiered space log holds some threads as summaries
// (their thread and counts records only); a scan under such a thread is
// UNKNOWN. The summaries are the ones the server marks (`summaries`), and
// any thread whose records show it incomplete (an ask with no run, or fewer
// first-level follow-ups or replies held than its counts record says). What
// the log holds under a thread a pull marks (follow-ups, replies, runs and
// their hide records) is dropped, in memory and in storage: a thread that
// left the full tier is not served again, and what the client held of it may
// be stale. A thread the person opened (`hydrate`) is reported in
// `tier.opened` (at most OPENED_MAX, the latest first) for 14 days, so the
// server keeps serving it in full.
//
// Live updates: `listen` holds an event stream for the logs open now with a
// cursor; it reconnects when that set changes or a log gets a new cursor (the
// stream drops a log whose token stops opening, and the poke it sends makes
// the client pull, resync and reconnect). A poke pulls its open logs, then
// sends the outbox. A stream the server refuses ends `listen` (UNAUTHORIZED
// signs out, UPDATE_REQUIRED holds).

import * as pkg from "@session/mutators";

import {
  CLOCK_MAX_SKEW,
  ID_MAX_AGE,
  ID_MAX_AHEAD,
  OPENED_MAX,
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
import { NO_RESPONSE, Offline, type CursorMap, type Transport } from "./transport.js";

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

/** An `event: run` frame of the stream: in-flight text of a run. */
export type RunFrame = Extract<SseEvent, { type: "run" }>;

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
  /** The ids the client made for its input (`ids` of the mutator). Only this
   * entry ever has them, so a record with one of them is this write's. */
  minted: string[];
  /** Online only: sent at once, never kept. */
  online?: boolean;
  /** The client's read tick when it was answered (this process only: set
   * again when the outbox is loaded). */
  answeredTick?: number;
  /** The seq the server recorded it under, when it answered with one: a read
   * of a log that says this client's last seq is at least this one holds
   * its effect. */
  answeredSeq?: number;
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
  /** The client's last recorded seq as the latest read of this log said it
   * (`lastSeq`): every write recorded at or before it is in that read. */
  pulledSeq: number;
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
  /** The default tier of the space logs it opens (default: the `desktop`
   * window). */
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
  "space.vis",
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
  private readonly tier: TierOptions;
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
  private readonly runListeners = new Set<(frame: RunFrame) => void>();
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
  /** No response at all to this many requests in a row: the outbox's
   * offline backoff. */
  private offline = 0;
  /** The writes waiting for the connection (no response): an answer from
   * the server ends their wait. */
  private readonly paused = new Set<OutboxEntry>();
  /** The write whose envelope is on the wire now (no answer yet). */
  private inFlight: OutboxEntry | null = null;
  /** A registration in flight (a read and a flush share it). */
  private registering: Promise<true | false | "offline"> | null = null;
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
    this.tier = o.tier ?? { window: "desktop" };
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
        // a backoff is this process's (a new one tries at once); a server's
        // `retryAt` still holds
        const { queuedMono, waitFrom, ...rest } = e;
        void queuedMono;
        const wire = e.wire ?? true;
        // a write held by UPDATE_REQUIRED waits no more: a new process is a
        // new version, and the server says so again if it is not
        const state = e.state === "held" ? "queued" : e.state;
        return {
          ...rest,
          ...(!e.own ? { next: 0 } : waitFrom !== undefined ? { waitFrom } : {}),
          sent: e.sent ?? true,
          wire,
          state,
          // its envelope may have been on the wire when the process ended:
          // it may have applied
          uncertain: e.uncertain || (wire && state === "queued"),
        };
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

  /** An answer's `serverTime` (NaN when the transport made the answer up).
   * The first one of the process sets the offset when the client's time is
   * more than a minute off it: a device clock that is days off makes its
   * ids, `queuedAt` and the 3-day drop on the server's time from the first
   * answer, without waiting for a CLOCK_SKEW. */
  private seen(serverTime: number) {
    if (!Number.isFinite(serverTime)) return;
    const first = this.timeAt === null;
    this.timeAt = { server: serverTime, mono: this.monotonic() };
    this.offline = 0;
    if (first && Math.abs(serverTime - this.now()) > CLOCK_MAX_SKEW) {
      this.reclock(serverTime, null);
      void this.persist();
    }
    // the connection is back: the writes waiting for it are due (the
    // client's timer sends them)
    if (this.paused.size) {
      for (const e of this.paused)
        if (e.state === "queued") {
          e.next = 0;
          delete e.waitFrom;
        }
      this.paused.clear();
      if (this.timer && !this.stopped) void this.flush();
    }
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

  /** A record of the confirmed state. A record two logs hold (read at
   * different times) is the copy with the higher rev: the log read later
   * may hold a newer copy than the log opened first. */
  confirmed(key: string): StoredRecord | undefined {
    let out: StoredRecord | undefined;
    for (const l of this.logs.values()) {
      const r = l.records.get(key);
      if (r && (!out || r.rev > out.rev)) out = r;
    }
    return out;
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

  /** The threads of `log` opened in the past 14 days, the latest first. */
  private opened(log: LogId): string[] {
    const by = this.meta.opened?.[log];
    if (!by) return [];
    const since = this.now() - OPENED_TTL;
    return Object.entries(by)
      .filter(([, at]) => at >= since)
      .sort(([, a], [, b]) => b - a)
      .map(([th]) => th);
  }

  private readOptions(log: LogId, extra: ReadOptions = {}): ReadOptions {
    const tier = this.logs.get(log)?.tier ?? this.tier;
    // at most OPENED_MAX: the server pins no more
    const opened = [...new Set([...(tier.opened ?? []), ...this.opened(log)])].slice(0, OPENED_MAX);
    return {
      ...(this.meta.clientId !== null ? { clientId: this.meta.clientId } : {}),
      ...(log.startsWith("space:") ? { tier: opened.length ? { ...tier, opened } : tier } : {}),
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
      pulledSeq: 0,
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
      // a read carries the client id, so a read the server makes as nobody
      // (a session that ended) or as another person is known (`lastSeq`)
      if (this.meta.clientId === null && !this.signedOut && !this.updateRequired)
        await this.register();
      for (const [log, l] of batch) {
        // signed out (an earlier read of this batch, or before it): what
        // the server serves now is not this person's
        if (this.signedOut) {
          served = false;
          break;
        }
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

  /** A served read sent with this client's id that the server did not make
   * as this client's person (`lastSeq: null`): the session ended, or it is
   * another person's. It is not applied, and the client is signed out; the
   * client id is forgotten, so the next registration (after `signedIn`)
   * makes one for the person signed in then. */
  private notMine(o: ReadOptions, lastSeq: number | null, serverTime: number): ReadError | null {
    if (o.clientId === undefined || lastSeq !== null) return null;
    if (this.meta.clientId === o.clientId) this.meta.clientId = null;
    return {
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Sign in again." },
      serverTime,
    };
  }

  /** Fetch one log: a pull, or a snapshot when it has no cursor or the pull
   * answers resync. Null: nothing to apply; false: not served. */
  private async fetch(log: LogId, l: LiveLog): Promise<Fetched | null | false> {
    if (l.frozen || this.logs.get(log) !== l) return null;
    // the tick at request time: an answer that arrived while this read was
    // in flight is not covered by it
    const tick = this.tick++;
    if (l.cursor !== null) {
      const o = this.readOptions(log);
      const p = await this.transport.pull(log, l.cursor, o);
      if (isReadError(p)) return this.readFailed(p);
      this.seen(p.serverTime);
      if (!("resync" in p)) {
        const no = this.notMine(o, p.lastSeq, p.serverTime);
        if (no) return this.readFailed(no);
        return { log, l, tick, pull: p };
      }
    }
    const o = this.readOptions(log);
    const s = await this.transport.snapshot(log, o);
    if (isReadError(s)) return this.readFailed(s);
    this.seen(s.serverTime);
    const no = this.notMine(o, s.lastSeq, s.serverTime);
    if (no) return this.readFailed(no);
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
      if (p.lastSeq !== null) l.pulledSeq = Math.max(l.pulledSeq, p.lastSeq);
      let changes: readonly Change[] = p.changes;
      if (p.summaries) {
        this.mark(
          l,
          p.changes.flatMap((c) => (c.op === "put" ? [c.record] : [])),
          p.summaries,
        );
        // a thread the server serves as a summary (one that left the full
        // tier had a row withheld): what the client holds under it may be
        // stale, and is dropped (`hydrate` fetches it again)
        const drop = this.heldUnder(l, new Set(p.summaries));
        if (drop.length) changes = [...changes, ...drop.map((key): Change => ({ key, op: "del" }))];
      }
      if (log === `user:${this.user}`) this.noteMembers(p.changes, p.ended);
      return this.applyChanges(log, l, changes, p.cursor, tick);
    }
    const s = f.snapshot;
    this.learn(s.lastSeq);
    if (s.lastSeq !== null) l.pulledSeq = Math.max(l.pulledSeq, s.lastSeq);
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

  /** The keys a log holds under `threads` that a summary does not serve:
   * their follow-ups, replies, runs and turns, and the hide records of
   * those. */
  private heldUnder(l: LiveLog, threads: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const under = (r: StoredRecord | undefined) =>
      (r?.kind === "followup" || r?.kind === "reply" || r?.kind === "run" || r?.kind === "turn") &&
      threads.has(r.th);
    for (const [k, r] of l.records)
      if (under(r) || (r.kind === "hide" && under(l.records.get(r.item)))) out.push(k);
    return out;
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
      if (
        l.marked.has(r.id) ||
        (r.k === "ask" && !runs.has(r.id)) ||
        (firsts.get(r.id) ?? 0) < want
      )
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
      if (this.logs.get(log) !== l || l.frozen || this.signedOut) return !this.signedOut;
      let s;
      const o = this.readOptions(log, { threads: [thread] });
      try {
        s = await this.transport.snapshot(log, o);
      } catch (e) {
        if (e instanceof Offline) return false;
        throw e;
      }
      if (isReadError(s)) return this.readFailed(s);
      this.seen(s.serverTime);
      const no = this.notMine(o, s.lastSeq, s.serverTime);
      if (no) return this.readFailed(no);
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
          : x.kind === "followup" || x.kind === "reply" || x.kind === "run" || x.kind === "turn"
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
    const pending = new Set(
      this.entries.flatMap((e) => (PENDING.has(e.state) ? [e.mutationId] : [])),
    );
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
      if (this.derivedOf(e.mutationId).has(id)) return true;
    }
    return false;
  }

  /** The ids a mutation id derives (cached while its write is pending). */
  private derivedOf(mutationId: string): Set<string> {
    let set = this.derivedCache.get(mutationId);
    if (!set) this.derivedCache.set(mutationId, (set = pkg.derivedIds(this.user, mutationId)));
    return set;
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
        // an answered write is in every log read after its answer: its
        // records there are the server's (and may hold later changes by
        // others), so it is not played again on top of them (phase 2b: a
        // decline undone at once came back as declined)
        if (e.state === "answered" && this.readAfter(key, draft, e)) continue;
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

  /** Whether a log that holds the record was read with the write's effect:
   * a read that started after its answer, or one whose `lastSeq` covers the
   * seq it was recorded under (a read sent before the answer came back but
   * served after the write). */
  private readAfter(key: string, draft: pkg.Draft | null, e: OutboxEntry) {
    const tick = e.answeredTick;
    if (tick === undefined) return false;
    const r = draft ?? this.confirmed(key);
    if (!r) return false;
    return pkg.logsOf(r).some((log) => {
      const l = this.logs.get(log);
      if (l === undefined || l.frozen) return false;
      return l.pulledTick > tick || (e.answeredSeq !== undefined && l.pulledSeq >= e.answeredSeq);
    });
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

  /** Take a shown write out of the list, or cancel a queued one. A write
   * whose envelope is on the wire cannot be cancelled (answers false): the
   * server may be applying it. */
  discard(local: string): boolean {
    const k = this.entries.findIndex((e) => e.local === local && e.state !== "answered");
    if (k < 0 || this.entries[k] === this.inFlight) return false;
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

  /** New input ids for `e` (its ids were never used on the server), made
   * at `at` (default: the client's time), with the writes that name them
   * changed to match. */
  private freshIds(e: OutboxEntry, at = this.now()) {
    const map = new Map(e.minted.map((id) => [id, pkg.ulid(at, this.random)]));
    this.remap(map, [e]);
  }

  /** The writes whose inputs may change: `own`, the queued and held writes
   * never sent (no envelope of them exists), and the shown writes the server
   * refused with a recorded answer and that never went without one (no
   * envelope of them can apply: Send again starts them afresh). A write
   * that may still apply as it was sent keeps its input. */
  private remappable(own: readonly OutboxEntry[] = []): OutboxEntry[] {
    return [...this.direct, ...this.entries].filter(
      (e) =>
        own.includes(e) ||
        (!e.sent && (e.state === "queued" || e.state === "held")) ||
        ((e.state === "refused" || e.state === "expired") && !e.uncertain),
    );
  }

  /** Replace ids in the inputs of the writes that may change. */
  private remap(map: ReadonlyMap<string, string>, own: readonly OutboxEntry[] = []) {
    if (!map.size) return;
    for (const e of this.remappable(own)) {
      e.input = remapValue(e.input, map);
      e.minted = e.minted.map((id) => map.get(id) ?? id);
    }
  }

  /** Give `e` the mutation id `next`. The ids its mutator derives
   * (`deriveId(user, mutation id, k)`: a run, a member's admission id, the
   * follow-ups a branch copies) change with it, so the writes that may
   * change and name a derived id of the old one name the new one's. */
  private rename(e: OutboxEntry, next: string) {
    const old = e.mutationId;
    if (old === next) return;
    e.mutationId = next;
    const time = old.slice(0, 10);
    const named = new Set<string>();
    for (const x of this.remappable())
      for (const v of stringsOf(x.input)) if (v.startsWith(time) && pkg.isUlid(v)) named.add(v);
    if (!named.size) return;
    const map = new Map<string, string>();
    for (let k = 1; k <= pkg.MAX_DERIVED && map.size < named.size; k++) {
      const id = pkg.deriveId(this.user, old, k);
      if (named.has(id)) map.set(id, pkg.deriveId(this.user, next, k));
    }
    this.remap(map);
  }

  /** Whether a client-made id is outside the server's window on the clock
   * `now`: more than 4 days old, or more than `ahead` ahead of it. */
  private outside(id: string, now: number, ahead: number): boolean {
    if (!pkg.isUlid(id)) return false;
    const t = pkg.ulidTime(id);
    return now - t > ID_MAX_AGE || t - now > ahead;
  }

  /** Before a write is sent: a mutation id never on the wire, and input ids
   * never sent, that are more than a minute ahead of the server's time (a
   * device clock that was ahead when they were made, and was corrected
   * since) are made again, at that time. The server's time is the one an
   * answer this session gave (and the monotonic clock since), not the
   * device's clock, which may be the one that is wrong now; before an
   * answer, the client's time. Ids that are old are left: a clock that was
   * behind by less than 4 days needs no new ids, and one further behind
   * answers EXPIRED, which Send again starts afresh. */
  private freshen(e: OutboxEntry, now: number) {
    const at = Math.round(this.serverNow() ?? now);
    const ahead = (id: string) => pkg.isUlid(id) && pkg.ulidTime(id) - at > ID_MAX_AHEAD;
    if (!e.wire && ahead(e.mutationId)) this.rename(e, pkg.ulid(at, this.random));
    if (!e.sent && e.minted.some(ahead)) this.freshIds(e, at);
  }

  /** Send a shown write again with a new mutation id.
   * - A write whose made ids the replica holds applied: it is answered.
   * - One never sent, or one the server refused with a recorded answer
   *   (EXPIRED, a refusal) that never went without an answer, never
   *   applied: it goes as a new write, with new input ids.
   * - Any other keeps its input ids (a create that applied under an
   *   envelope whose answer is gone answers CONFLICT on its own id, which
   *   reads as applied), and a failed or dropped one lists its sent ids in
   *   `replaces`, so a write the server applied under an old id is answered
   *   from it.
   * A recorded refusal is never listed: it would be replayed.
   *
   * `input` replaces the write's input (the person changed the text of a
   * create that went without an answer). It must make the same ids as the
   * write's input, so the write stays the one create and never becomes a
   * second one; otherwise nothing changes and the answer is false. A write
   * that applied (its ids are in the replica, or the server answers from an
   * earlier envelope under `replaces`) keeps what it applied. */
  sendAgain(local: string, o: { input?: unknown } = {}): boolean {
    const e = this.entries.find((x) => x.local === local && SHOWN.has(x.state));
    if (!e) return false;
    let input: unknown = e.input;
    if (o.input !== undefined) {
      const def = this.registry.get(e.name);
      const parsed = def?.input.safeParse(o.input);
      const ids = parsed?.success && def ? def.ids(parsed.data) : null;
      if (!ids || ids.length !== e.minted.length || ids.some((id, k) => id !== e.minted[k]))
        return false;
      input = json(o.input);
    }
    const refused = e.state === "expired" || e.state === "refused";
    if (this.appliedHere(e)) {
      e.state = "answered";
      e.answeredTick = this.tick++;
      delete e.error;
      void this.persist();
      this.rebase();
      return true;
    }
    e.input = input;
    if (!e.sent || (refused && !e.uncertain)) {
      e.replaces = [];
      e.sent = false;
      e.uncertain = false;
      this.freshIds(e);
    } else if (refused) e.replaces = [];
    else if (e.wire) e.replaces = uniq([...e.replaces, e.mutationId]);
    this.rename(e, this.newId());
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
    this.offline = 0;
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

  /** Register a client id if there is none: true when there is one, false
   * when the server refused (UPDATE_REQUIRED holds, UNAUTHORIZED signs out),
   * "offline" when no answer arrived. One registration at a time. */
  private register(): Promise<true | false | "offline"> {
    if (this.meta.clientId !== null) return Promise.resolve(true);
    this.registering ??= this.registerOnce().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  private async registerOnce(): Promise<true | false | "offline"> {
    let r;
    try {
      r = await this.transport.register();
    } catch (e) {
      if (e instanceof Offline) return "offline";
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
    // a new registration numbers its writes from 1 again
    for (const l of this.logs.values()) l.pulledSeq = 0;
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

  /** A write still queued 3 days after it was queued is dropped and shown,
   * never sent: by the monotonic clock for a write queued in this process,
   * else by the server's time (an answer this session gave it) against its
   * `queuedAt`. */
  private expire() {
    const now = this.serverNow();
    const mono = this.monotonic();
    for (const e of this.entries) {
      if (e.state !== "queued") continue;
      const age =
        e.queuedMono !== undefined ? mono - e.queuedMono : now === null ? 0 : now - e.queuedAt;
      if (age >= OUTBOX_TTL) this.end(e, "dropped");
    }
  }

  private end(e: OutboxEntry, state: EntryState, error?: ApiError, a: Answer | null = null) {
    e.state = state;
    if (error) e.error = error;
    // online only: never kept
    if (e.online) this.direct = this.direct.filter((x) => x !== e);
    this.resolve(e, a);
  }

  /** The offset is corrected to the server's time (CLOCK_SKEW, or the first
   * answer of the process): every queued write's waits move to the corrected
   * clock, and its `queuedAt` is set again (from the monotonic clock when it
   * was queued in this process; else at most now). A mutation id that was on
   * the wire and that the corrected clock puts outside the server's window
   * by more than a wait (over 4 days old, or over 10 minutes ahead) gets a
   * new id, the old one in `replaces`; a write whose last send went without
   * an answer keeps its id (AGENTS.md). `answered` is the write the
   * CLOCK_SKEW answered. Mutation ids never on the wire, and input ids never
   * sent, are made again before they are sent (`freshen`); a sent write's
   * ids that are ahead wait (`idsDue`). */
  private reclock(serverTime: number, answered: OutboxEntry | null) {
    const delta = serverTime - this.clock.now() - this.meta.offset;
    this.meta.offset += delta;
    const now = Math.round(this.now());
    const mono = this.monotonic();
    for (const e of [...this.direct, ...this.entries]) {
      if (e.state !== "queued") continue;
      // a wait is on the corrected clock too (a backoff from when it began;
      // a `retryAt` is the server's time already)
      if (e.waitFrom !== undefined) {
        e.waitFrom += delta;
        if (!e.own) e.next += delta;
      }
      e.queuedAt =
        e.queuedMono !== undefined
          ? Math.min(now, Math.round(now - (mono - e.queuedMono)))
          : Math.min(now, e.queuedAt);
      if (
        e.wire &&
        (e === answered || !e.uncertain) &&
        this.outside(e.mutationId, now, RETRY_MAX)
      ) {
        e.replaces = uniq([...e.replaces, e.mutationId]);
        this.rename(e, this.newId());
        e.wire = false;
      }
    }
  }

  /** A replayed answer: the server processed an older envelope of the
   * write. Its derived ids are those of the mutation id it was recorded
   * under (`recordedAs`), so the write takes that id and the writes that may
   * change follow; a result naming another id than the input's moves the
   * write and those writes to the server's id. */
  private adopt(e: OutboxEntry, a: Extract<Answer, { ok: true }>) {
    if (typeof a.recordedAs === "string" && pkg.isUlid(a.recordedAs)) this.rename(e, a.recordedAs);
    const id = (a.result as { id?: unknown } | null)?.id;
    const mine = e.minted[0];
    if (e.minted.length !== 1 || typeof id !== "string" || mine === undefined || id === mine)
      return;
    this.remap(new Map([[mine, id]]), [e]);
  }

  /** When `e`'s fixed ids (its input ids once sent, its mutation id once on
   * the wire) are within a minute of the server's clock: ids made by a
   * device clock that was ahead wait. */
  private idsDue(e: OutboxEntry): number {
    let at = 0;
    for (const id of [...(e.sent ? e.minted : []), ...(e.wire ? [e.mutationId] : [])])
      if (pkg.isUlid(id)) at = Math.max(at, pkg.ulidTime(id));
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
   * it makes or derives, which wait with it). */
  private pick(now = this.now()): OutboxEntry | null {
    const d = this.direct.find((e) => e.state === "queued");
    if (d) return d;
    if (this.updateRequired || this.signedOut) return null;
    const held = new Set<string>();
    const heldMutations: string[] = [];
    const names = (e: OutboxEntry) =>
      [...stringsOf(e.input)].some(
        (x) =>
          held.has(x) ||
          heldMutations.some((m) => m.slice(0, 10) === x.slice(0, 10) && this.derivedOf(m).has(x)),
      );
    for (const e of this.entries) {
      if (e.state !== "queued") continue;
      const due = this.dueAt(e, now) <= now;
      if ((e.own && !due) || (heldMutations.length > 0 && names(e))) {
        for (const id of e.minted) held.add(id);
        heldMutations.push(e.mutationId);
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

  /** The writes that cannot wait end as failed: online writes when the
   * client is held or signed out, or when a flush ends blocked (`blocked`:
   * offline, or a registration the server refused); on the web (`persist:
   * false`) the queued writes too when it is signed out (shown with Try
   * again). */
  private failStuck(blocked = false) {
    const why: ApiError | null = this.updateRequired
      ? { code: "UPDATE_REQUIRED", message: "Update Session." }
      : this.signedOut
        ? { code: "UNAUTHORIZED", message: "Sign in again." }
        : blocked
          ? { code: "SERVICE_UNAVAILABLE", message: "The server could not be reached." }
          : null;
    if (!why) return;
    for (const e of [...this.direct]) this.end(e, "failed", why);
    if (!this.keep && this.signedOut)
      for (const e of this.entries) if (e.state === "queued") this.end(e, "failed", why);
  }

  /** No response at all to `e` (`sent`: its envelope may have reached the
   * server): not a try. The outbox pauses with backoff (1 s, doubled, at most
   * 10 minutes, counted over the requests in a row that got none) and the
   * write waits for the connection or the 3-day drop. An online write, and a
   * write on the web, end as failed at once. */
  private noResponse(e: OutboxEntry, now: number, sent: boolean) {
    if (sent) e.uncertain = true;
    if (e.online || !this.keep) {
      this.end(e, "failed", { code: "SERVICE_UNAVAILABLE", message: "No connection." });
      return;
    }
    this.offline++;
    e.next = now + backoff(this.offline);
    e.waitFrom = now;
    e.own = false;
    this.paused.add(e);
  }

  /** A CONFLICT on an id the write's input makes, for a write sent before:
   * only this client makes those ids, so an earlier envelope of it applied
   * (its answer is gone). */
  private appliedBefore(e: OutboxEntry, sentBefore: boolean, error: AnswerError): boolean {
    return (
      sentBefore &&
      e.minted.length > 0 &&
      error.code === "CONFLICT" &&
      error.message === pkg.ID_TAKEN
    );
  }

  /** One pass over the outbox. Answers whether it is blocked (no server,
   * held, signed out), so the flush does not go round again. */
  private async flushOnce(): Promise<boolean> {
    this.expire();
    if (this.updateRequired) this.hold();
    this.failStuck();
    let blocked = false;
    const head = this.pick();
    if (head === null) {
      // nothing to send now
    } else {
      const reg = await this.register();
      if (reg !== true) {
        blocked = true;
        // the head waits for the connection like a write that got no
        // response (the registration was not a request for it)
        const e = this.pick();
        if (reg === "offline" && e) this.noResponse(e, this.now(), false);
      }
    }
    if (!blocked && head !== null) {
      let skews = 0;
      let gaps = 0;
      let fresh = 0;
      for (;;) {
        this.expire();
        this.failStuck();
        const now = this.now();
        const e = this.pick(now);
        if (!e) break;
        if (!e.online) this.freshen(e, now);
        // ids a device clock made ahead of the server's: the outbox waits
        // until they are within a minute, for at most 10 minutes (the web
        // shows it with Try again). Ids further ahead are sent: the server's
        // EXPIRED is recorded under every id the write had, so no copy of it
        // applies later, and Send again starts it afresh
        const ids = this.idsDue(e);
        if (ids > now && ids - now <= RETRY_MAX && !e.online) {
          if (!this.keep) {
            this.end(e, "failed", {
              code: "CLOCK_SKEW",
              message: "This device's clock is ahead of the server's.",
            });
            continue;
          }
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
          // not after it is sent (a `queuedAt` made on a clock that was
          // ahead); the entry keeps its own
          queuedAt: Math.min(e.queuedAt, Math.max(0, Math.round(now))),
          replaces: e.replaces,
        };
        const sentBefore = e.sent;
        e.sent = true;
        e.wire = true;
        // what goes on the wire is in storage first (a remint, `uncertain`)
        if (!e.online) await this.persist();
        this.sent.push({ local: e.local, mutationId: e.mutationId, seq: env.seq });
        if (this.sent.length > SENT_KEPT) this.sent.splice(0, this.sent.length - SENT_KEPT);
        this.inFlight = e;
        let a;
        try {
          [a] = await this.transport.push([env]);
        } finally {
          this.inFlight = null;
        }
        if (a === NO_RESPONSE) {
          this.noResponse(e, now, true);
          if (e.state !== "queued") continue;
          blocked = true;
          break;
        }
        if (!a) {
          // a response that is not an answer: it may have been applied
          e.uncertain = true;
          if (this.transient(e, now, undefined)) continue;
          break;
        }
        this.seen(a.serverTime);
        if (!a.ok) {
          const code = a.error.code;
          if (code === "CLOCK_SKEW" && skews++ < 3) {
            this.reclock(a.serverTime, e);
            continue;
          }
          if (code === "OUT_OF_ORDER" && a.error.expectedSeq !== undefined && gaps++ < 3) {
            this.meta.lastSeq = a.error.expectedSeq - 1;
            continue;
          }
          if (code === "WRONG_CLIENT" && fresh++ < 1) {
            this.meta.clientId = null;
            if ((await this.register()) === true) continue;
            blocked = true;
            break;
          }
          if (code === "UNAUTHORIZED" || code === "WRONG_CLIENT") {
            this.signOut();
            this.failStuck();
            blocked = true;
            break;
          }
          if (code === "UPDATE_REQUIRED") {
            this.hold();
            this.failStuck();
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
        if (!a.ok && !this.appliedBefore(e, sentBefore, a.error)) {
          // the recorded answer covers every id it had: none can apply (Send
          // again lists none of them). EXPIRED of a write whose input makes
          // ids: none of them exists (the server answers CONFLICT when one
          // does), so no envelope of it applied
          if (a.error.code === "EXPIRED" && e.minted.length > 0) e.uncertain = false;
          await this.applyAnswerChanges(a.error.changes);
          this.end(e, a.error.code === "EXPIRED" ? "expired" : "refused", a.error, a);
        } else {
          if (a.ok && a.replayed) this.adopt(e, a);
          if (e.online) this.direct = this.direct.filter((x) => x !== e);
          e.state = "answered";
          e.result = a.ok ? a.result : null;
          e.uncertain = false;
          e.answeredTick = this.tick++;
          if (a.seq !== undefined) e.answeredSeq = a.seq;
          if (e.name === "threads.delete") this.unfreeze((e.input as { id: string }).id);
          this.noteLeave(e);
          this.resolve(
            e,
            a.ok
              ? a
              : {
                  ok: true,
                  result: null,
                  serverTime: a.serverTime,
                  ...(a.seq !== undefined ? { seq: a.seq } : {}),
                },
          );
        }
        this.rebase();
      }
    }
    if (blocked) this.failStuck(true);
    await this.persist();
    this.rebase();
    return blocked;
  }

  /** A try that failed (a transient answer, or a response that is not an
   * answer): wait the backoff, or the answer's `retryAt` (this write only),
   * or after 5 tries (online only or on the web: at once) show it as failed.
   * Answers whether the flush goes on. */
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

  /** In-flight text of runs (ADR-22): each `event: run` frame of the stream
   * (`{ run, attempt, seq, text }`, `text` the text since the frame before)
   * is passed to the listeners. It is not stored and changes no log: the
   * turns, the answer and the run's end arrive as records. */
  onRun(listener: (frame: RunFrame) => void): () => void {
    this.runListeners.add(listener);
    return () => void this.runListeners.delete(listener);
  }

  /** Listen for pokes until `signal` aborts: each poke pulls its open logs,
   * then the outbox is sent (an answer that arrived as a change); a run
   * frame goes to the `onRun` listeners. The stream reconnects when the
   * open logs or their cursors change. A stream the server refused ends it:
   * UNAUTHORIZED signs the client out, UPDATE_REQUIRED holds the outbox. */
  async listen(signal: AbortSignal): Promise<void> {
    const onEvent = (e: SseEvent) => {
      if (e.type === "run") {
        for (const l of [...this.runListeners]) l(e);
        return;
      }
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
      let refused;
      try {
        refused = await this.transport.listen(() => this.cursors(), onEvent, conn.signal);
      } finally {
        signal.removeEventListener("abort", stop);
        if (this.stream === conn) this.stream = null;
      }
      if (refused) {
        this.readFailed(refused);
        return;
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
