// The client half: a replica of what its user may read, one cursor token per
// log, an outbox in one global order, prediction and rebase, and reactive
// queries. It is replica-proto's `client.ts` made production-shaped, with
// the outbox driver of the mockup (`sxDrive`).
//
// The replica: each open log's records as the server last served them (the
// confirmed state), loaded from storage into the working set when the log is
// opened, and written back on each change. Queries read the working set
// through the overlay of pending writes.
//
// Prediction: each pending write is applied with `@session/mutators` over
// the confirmed state and the writes before it (a `RecordSource` that
// answers UNKNOWN for what the replica cannot know, wrapped in `withOwnIds`
// with each mutation's derived ids cached). A write the mutators answer
// `unknown` stays pending without a prediction. On every change of the
// confirmed state (a pull, a snapshot, an answer's records) the overlay is
// rebuilt: rolled back, the changes applied, the pending writes run again.
// An answered write stays in the overlay until every open log was pulled
// after its answer, so its effect does not flicker.
//
// The outbox (AGENTS.md; the mockup's `sxDrive`):
// - one global order; a write gets its seq when it is sent (the last seq the
//   server processed + 1);
// - every envelope carries `clientTime` (the device's clock plus the offset
//   learned from CLOCK_SKEW, which is stored) and `queuedAt`;
// - CLOCK_SKEW: the offset is corrected and the writes that were never sent
//   uncertainly get new ids, each listing the ids it had in `replaces`;
// - TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR or no
//   answer: the outbox pauses with backoff (1 s, doubled, at most 10 min;
//   `retryAt` when the server gives one); after 5, the write is shown as
//   failed and the outbox goes on;
// - EXPIRED, and a write still queued 3 days after `queuedAt` (server time),
//   are shown;
// - UPDATE_REQUIRED holds the write and every write after it ("Update
//   Session");
// - OUT_OF_ORDER resends with the server's expected seq, WRONG_CLIENT
//   registers again;
// - Send again on a failed write gives it a new mutation id that lists the
//   old ones in `replaces`.
// Persistence is optional: with `MemoryStorage` (the web) a write lives only
// while the page does.
//
// Scope: a pull that answers resync takes a new snapshot of that log. A
// closed space whose snapshot shows its user is no longer a member becomes a
// frozen copy: the user's own threads and what they wrote under them, never
// pulled again (they can still delete their threads there). Joining again
// (a member record in the user log) brings the log back.

import * as pkg from "@session/mutators";

import {
  MAX_TRIES,
  OUTBOX_TTL,
  PROTOCOL_VERSION,
  TRANSIENT,
  UNRECORDED,
  backoff,
  type Answer,
  type AnswerError,
  type ApiError,
  type CallAnswer,
  type Change,
  type Cursor,
  type LogId,
  type ReadOptions,
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
  /** The mutation ids it had before it was reminted. */
  replaces: string[];
  /** An envelope with this mutation id may have reached the server without
   * a definite answer: it keeps the id from then on. */
  uncertain: boolean;
  tries: number;
  /** Not sent before this time (client time). */
  next: number;
  state: EntryState;
  error?: ApiError;
  result?: unknown;
  /** The ids the client made for its input (`ids` of the mutator). */
  minted: string[];
  /** Online only: sent at once, never kept. */
  online?: boolean;
  /** The client's read tick when it was answered. */
  answeredTick?: number;
  /** What the mutators predicted. */
  prediction?: "ok" | "refused" | "unknown";
  predictedError?: ApiError;
}

interface LiveLog {
  cursor: Cursor | null;
  records: Map<string, StoredRecord>;
  frozen: boolean;
  /** The read tick of its latest successful read. */
  pulledTick: number;
  tier: TierOptions | undefined;
  /** Threads served as summaries: their follow-ups, replies and runs are not
   * held (a scan of them is UNKNOWN). */
  summaries: Set<string>;
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

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The record a client-made id is the id of, if any (`idOf`). */
const idOfRecord = (r: StoredRecord) => pkg.idOf(r);

export class SyncClient implements Changing {
  readonly user: string;
  private readonly transport: Transport;
  private readonly storage: StorageAdapter;
  private readonly clock: { now(): number };
  private readonly random: () => number;
  private readonly registry: pkg.Registry;
  private readonly tier: TierOptions | undefined;
  private meta: ClientMeta;
  private readonly logs = new Map<LogId, LiveLog>();
  private overlay = new Map<string, StoredRecord | null>();
  private entries: OutboxEntry[] = [];
  private readonly derivedCache = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, ((a: Answer | null) => void)[]>();
  private readonly listeners = new Set<() => void>();
  private ver = 0;
  private tick = 0;
  private flushing: Promise<void> | null = null;
  /** The server answered UPDATE_REQUIRED: nothing is sent until an update. */
  updateRequired = false;
  /** Every envelope sent, and every answer (tests). */
  readonly sent: { local: string; mutationId: string; seq: number }[] = [];

  constructor(o: ClientOptions) {
    this.user = o.user;
    this.transport = o.transport;
    this.storage = o.storage ?? new MemoryStorage();
    this.clock = o.clock ?? { now: () => Date.now() };
    this.random = o.random ?? Math.random;
    this.registry = o.registry ?? pkg.MUTATORS;
    this.tier = o.tier;
    this.meta = { user: o.user, clientId: null, lastSeq: 0, offset: 0 };
  }

  /** Load the stored meta and outbox (a client restored after a restart).
   * A stored state of another person is discarded. */
  async init(): Promise<void> {
    const m = await this.storage.loadMeta();
    if (m && m.user === this.user) this.meta = m;
    else if (m) await this.storage.clear();
    this.entries = ((await this.storage.loadOutbox()) as OutboxEntry[]).filter(
      (e) => e && typeof e.local === "string",
    );
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

  private readOptions(log: LogId, extra: ReadOptions = {}): ReadOptions {
    const tier = this.logs.get(log)?.tier ?? this.tier;
    return {
      ...(this.meta.clientId !== null ? { clientId: this.meta.clientId } : {}),
      ...(log.startsWith("space:") && tier ? { tier } : {}),
      ...extra,
    };
  }

  private learn(lastSeq: number | null) {
    if (lastSeq !== null && lastSeq > this.meta.lastSeq) this.meta.lastSeq = lastSeq;
  }

  /** Bring a log into the working set: from storage when it is there, else a
   * snapshot. */
  async open(log: LogId, tier?: TierOptions): Promise<void> {
    if (this.logs.has(log)) return;
    const stored = await this.storage.loadLog(log);
    const t = tier ?? (log.startsWith("space:") ? this.tier : undefined);
    if (stored) {
      this.logs.set(log, {
        cursor: stored.cursor,
        records: new Map(stored.records),
        frozen: stored.frozen,
        pulledTick: -1,
        tier: t,
        summaries: new Set(),
      });
      this.rebase();
      return;
    }
    this.logs.set(log, {
      cursor: null,
      records: new Map(),
      frozen: false,
      pulledTick: -1,
      tier: t,
      summaries: new Set(),
    });
    await this.sync(log);
  }

  /** Take a log out of the working set (it stays in storage). */
  close(log: LogId) {
    if (this.logs.delete(log)) this.rebase();
  }

  /** Bring open logs up to date: a pull, or a snapshot the first time and
   * after a resync. Answers false when the server could not be reached. */
  async sync(...only: LogId[]): Promise<boolean> {
    const logs = only.length ? only : [...this.logs.keys()];
    let reached = true;
    for (const log of logs) {
      try {
        await this.syncOne(log);
      } catch (e) {
        if (e instanceof Offline) reached = false;
        else throw e;
      }
    }
    // a frozen space the user is a member of again comes back
    const me = this.logs.get(`user:${this.user}`);
    if (me)
      for (const [log, l] of this.logs)
        if (l.frozen && me.records.has(pkg.memberKey(log.slice(6), this.user))) {
          l.frozen = false;
          l.cursor = null;
          try {
            await this.syncOne(log);
          } catch (e) {
            if (!(e instanceof Offline)) throw e;
            reached = false;
          }
        }
    return reached;
  }

  private async syncOne(log: LogId) {
    const l = this.logs.get(log);
    if (!l || l.frozen) return;
    if (l.cursor !== null) {
      const p = await this.transport.pull(log, l.cursor, this.readOptions(log));
      if (!("resync" in p)) {
        this.learn(p.lastSeq);
        await this.applyChanges(log, p.changes, p.cursor);
        return;
      }
    }
    const s = await this.transport.snapshot(log, this.readOptions(log));
    this.learn(s.lastSeq);
    const records = new Map(s.records.map((x) => [x.key, x.record]));
    const before = l.records;
    const frozen = l.cursor !== null && this.freeze(log, before, records);
    l.cursor = s.cursor;
    l.pulledTick = this.tick++;
    l.summaries = this.summariesOf(log, records);
    if (frozen) {
      l.records = frozen;
      l.frozen = true;
    } else l.records = records;
    await this.storage.saveLog(log, {
      cursor: l.cursor,
      frozen: l.frozen,
      replace: true,
      puts: [...l.records],
      dels: [],
    });
    this.settle();
  }

  /** The threads of a space snapshot held as summaries: an ask with no
   * follow-up and no run, or a post with no reply, in a tiered read (the
   * server sends a summary's thread and counts only). */
  private summariesOf(log: LogId, records: Map<string, StoredRecord>): Set<string> {
    const out = new Set<string>();
    const tier = this.logs.get(log)?.tier ?? this.tier;
    if (!log.startsWith("space:") || !tier || tier.window === "full") return out;
    const under = new Set<string>();
    for (const r of records.values())
      if (r.kind === "followup" || r.kind === "reply" || r.kind === "run") under.add(r.th);
    for (const r of records.values()) {
      if (r.kind !== "thread" || under.has(r.id)) continue;
      const c = records.get(pkg.countsKey(r.id));
      if (r.k === "ask" || (c?.kind === "counts" && c.r > 0)) out.add(r.id);
    }
    return out;
  }

  /** Fetch one thread in full (a summary the person opened). */
  async hydrate(log: LogId, thread: string): Promise<void> {
    const l = this.logs.get(log);
    if (!l || l.frozen) return;
    const s = await this.transport.snapshot(log, this.readOptions(log, { threads: [thread] }));
    const puts = s.records.map((x): [string, StoredRecord] => [x.key, x.record]);
    for (const [k, r] of puts) l.records.set(k, r);
    l.summaries.delete(thread);
    await this.storage.saveLog(log, { cursor: l.cursor, puts, dels: [] });
    this.rebase();
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

  /** Apply changes the server served for a log. */
  private async applyChanges(log: LogId, changes: readonly Change[], cursor: Cursor | null) {
    const l = this.logs.get(log);
    if (!l) return;
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
    l.pulledTick = this.tick++;
    await this.storage.saveLog(log, { cursor: l.cursor, puts, dels });
    this.settle();
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
      if (mine.length) await this.applyChanges(log, mine, null);
    }
  }

  /** Drop the answered writes every open log has been pulled after, then
   * rebuild the overlay. */
  private settle() {
    const live = [...this.logs.values()].filter((l) => !l.frozen);
    const oldest = live.length ? Math.min(...live.map((l) => l.pulledTick)) : Infinity;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.state !== "answered" || (e.answeredTick ?? Infinity) >= oldest,
    );
    if (this.entries.length !== before) void this.persist();
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
        this.overlay.set(key, { ...draft, rev } as StoredRecord);
      }
    }
    this.changed();
  }

  // ---- writes ----

  /** Queue a write, predict it, and send the outbox. Answers its local id
   * and a promise of the server's answer (null: it ended without one: shown,
   * or dropped). */
  write(name: string, input: unknown): { local: string; answer: Promise<Answer | null> } {
    const def = this.registry.get(name);
    const parsed = def?.input.safeParse(input);
    const minted = parsed?.success && def ? def.ids(parsed.data) : [];
    const now = this.now();
    const e: OutboxEntry = {
      local: pkg.ulid(now, this.random),
      mutationId: this.newId(),
      name,
      input: json(input),
      queuedAt: Math.round(now),
      replaces: [],
      uncertain: false,
      tries: 0,
      next: 0,
      state: "queued",
      minted,
      ...(def?.online ? { online: true } : {}),
    };
    this.entries.push(e);
    const answer = new Promise<Answer | null>((resolve) => {
      this.waiters.set(e.local, [...(this.waiters.get(e.local) ?? []), resolve]);
    });
    void this.persist();
    this.rebase();
    void this.flush();
    return { local: e.local, answer };
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
    await this.storage.saveOutbox(this.entries);
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

  /** Send a failed (or expired, or dropped) write again: a new mutation id,
   * the old ones in `replaces`, so a write the server applied under an old
   * id is answered from it and never applied twice. */
  sendAgain(local: string): boolean {
    const e = this.entries.find((x) => x.local === local && SHOWN.has(x.state));
    if (!e) return false;
    e.replaces = [...new Set([...e.replaces, e.mutationId])];
    e.mutationId = this.newId();
    e.queuedAt = Math.round(this.now());
    e.uncertain = false;
    e.tries = 0;
    e.next = 0;
    e.state = "queued";
    delete e.error;
    void this.persist();
    this.rebase();
    void this.flush();
    return true;
  }

  /** "Retry now": a waiting write is sent now. */
  retryNow() {
    for (const e of this.entries) if (e.state === "queued") e.next = 0;
    return this.flush();
  }

  /** After an update: the held writes are sent again. */
  updated() {
    this.updateRequired = false;
    for (const e of this.entries) if (e.state === "held") e.state = "queued";
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
    if (!r.ok) {
      if (r.error.code === "UPDATE_REQUIRED") this.hold();
      return false;
    }
    this.meta.clientId = r.clientId;
    this.meta.lastSeq = 0;
    await this.persist();
    return true;
  }

  private hold() {
    this.updateRequired = true;
    for (const e of this.entries) if (e.state === "queued") e.state = "held";
  }

  /** A write still queued 3 days after it was queued (server time) is
   * dropped and shown, never sent. */
  private expire() {
    const now = this.now();
    for (const e of this.entries)
      if (e.state === "queued" && now - e.queuedAt >= OUTBOX_TTL) this.end(e, "dropped");
  }

  private end(e: OutboxEntry, state: EntryState, error?: ApiError, a: Answer | null = null) {
    e.state = state;
    if (error) e.error = error;
    if (e.online && state === "failed") {
      // online only: never kept
      this.entries = this.entries.filter((x) => x !== e);
    }
    this.resolve(e, a);
  }

  /** New ids for the writes that never reached the server uncertainly
   * (their ids came from a clock that was off): a new mutation id that lists
   * the old one in `replaces`, and new client-made ids in their inputs, with
   * every write that names those ids changed to match. */
  private remint() {
    const map = new Map<string, string>();
    for (const e of this.entries) {
      if (e.state !== "queued" || e.uncertain) continue;
      for (const id of e.minted) map.set(id, this.newId());
      e.replaces = [...new Set([...e.replaces, e.mutationId])];
      e.mutationId = this.newId();
      e.queuedAt = Math.round(this.now());
    }
    if (!map.size) return;
    const remap = (v: unknown): unknown =>
      typeof v === "string"
        ? (map.get(v) ?? v)
        : Array.isArray(v)
          ? v.map(remap)
          : v !== null && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)]))
            : v;
    for (const e of this.entries) {
      if (e.state !== "queued" || e.uncertain) continue;
      e.input = remap(e.input);
      e.minted = e.minted.map((id) => map.get(id) ?? id);
    }
  }

  /** Send the outbox in order (one flush at a time). */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce() {
    this.expire();
    if (this.updateRequired) this.hold();
    if (!this.entries.some((e) => e.state === "queued")) return this.persist();
    if (!(await this.register())) return this.persist();
    let skews = 0;
    let gaps = 0;
    let fresh = 0;
    for (;;) {
      this.expire();
      const e = this.entries.find((x) => x.state === "queued");
      if (!e || this.updateRequired) break;
      const now = this.now();
      // waiting out its backoff: the outbox pauses (a wait past the longest
      // backoff means the device's clock went back: it is sent now)
      if (e.next > now && e.next - now <= 2 * 600_000) break;
      const env = {
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
      this.sent.push({ local: e.local, mutationId: e.mutationId, seq: env.seq });
      const [a] = await this.transport.push([env]);
      if (!a) {
        // no answer: it may have been applied; it keeps its id from now on
        e.uncertain = true;
        if (this.transient(e, now, undefined)) continue;
        break;
      }
      if (!a.ok) {
        const code = a.error.code;
        if (code === "CLOCK_SKEW" && skews++ < 3) {
          this.meta.offset = a.serverTime - this.clock.now();
          this.remint();
          continue;
        }
        if (code === "OUT_OF_ORDER" && a.error.expectedSeq !== undefined && gaps++ < 3) {
          this.meta.lastSeq = a.error.expectedSeq - 1;
          continue;
        }
        if (code === "WRONG_CLIENT" && fresh++ < 1) {
          this.meta.clientId = null;
          if (!(await this.register())) break;
          continue;
        }
        if (code === "UPDATE_REQUIRED") {
          this.hold();
          break;
        }
        if (TRANSIENT.has(code)) {
          if (this.transient(e, now, a.error)) continue;
          break;
        }
        if (code === "TOO_LARGE") {
          this.end(e, "failed", a.error, a);
          continue;
        }
        if (UNRECORDED.has(code)) break;
      }
      // recorded (or replayed): applied or refused
      if (a.seq !== undefined) this.meta.lastSeq = Math.max(this.meta.lastSeq, a.seq);
      skews = 0;
      gaps = 0;
      if (a.ok) {
        e.state = "answered";
        e.result = a.result;
        e.answeredTick = this.tick++;
        if (e.name === "threads.delete") this.unfreeze((e.input as { id: string }).id);
        this.resolve(e, a);
      } else {
        await this.applyAnswerChanges((a.error as AnswerError).changes);
        this.end(e, a.error.code === "EXPIRED" ? "expired" : "refused", a.error, a);
      }
      await this.persist();
      this.rebase();
    }
    await this.persist();
    this.rebase();
  }

  /** A transient answer (or none): try again after the backoff, or after 5
   * show it as failed. Answers whether the flush goes on. */
  private transient(e: OutboxEntry, now: number, error: AnswerError | undefined): boolean {
    e.tries++;
    if (e.online || e.tries >= MAX_TRIES) {
      this.end(
        e,
        "failed",
        error ?? { code: "SERVICE_UNAVAILABLE", message: "No answer from the server." },
      );
      return true;
    }
    const at = error?.retryAt ? pkg.msOf(error.retryAt) : NaN;
    e.next = Number.isFinite(at) ? at : now + backoff(e.tries);
    return false;
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

  /** Listen for pokes until `signal` aborts: each poke pulls its logs, then
   * the outbox is sent (an answer that arrived as a change). */
  async listen(signal: AbortSignal): Promise<void> {
    await this.transport.listen(
      () => this.cursors(),
      (e: SseEvent) => {
        if (e.type === "poke") void this.sync(...e.logs.filter((l) => this.logs.has(l)));
      },
      signal,
    );
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
