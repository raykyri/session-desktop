// The client half (`01` §4.3): a replica of the logs its user reads (Y9),
// built from snapshots and kept current with pulls; an outbox in one global
// order across logs (Y10); predictions of the pending writes rebased on the
// confirmed state (Y11); and change notifications for reactive queries (Y12).
// Ported from `replica-proto/src/client.ts`, whose suite runs on it.
//
// A client belongs to one person for its lifetime: it has no way to change
// the person it reads for, so a replica never holds what another person
// read. Its client id is bound to that person on the server too.
//
// Outbox. A write gets its seq when it is sent: the last seq the server
// acknowledged + 1, so a write dropped before it was sent leaves no gap.
// Writes are sent one at a time, in queue order. Each envelope carries
// `clientTime` (the client's clock corrected by the offset it learned from
// CLOCK_SKEW) and `queuedAt`. Once an envelope of a write may have reached
// the server without a definite answer, the write keeps its mutation id for
// good. A write never sent that way gets new ids after CLOCK_SKEW, and its
// envelope lists the ids it had in `replaces`.
//
// Two policies (Y10):
// - `in-flight` (the web client): the outbox holds a write only while its
//   request is in flight. A write with no answer, or a transient or other
//   unrecorded one, leaves the outbox as "Not sent" (`unsent`), its
//   prediction kept, until the person retries it (same mutation id) or
//   discards it (rolled back). The writes behind it are sent.
// - `queue` (the suites, and a future persistent client): the write stays at
//   the head of the outbox and is sent again after 1 s, 2 s, 4 s, … up to 10
//   minutes; after 5 INTERNAL_SERVER_ERROR answers it is shown as FAILED and
//   the writes behind it are sent; a write still queued 3 days after it was
//   queued, in the server's time as the client estimates it, is DROPPED and
//   shown.
// In both: recorded answers (applied or refused) acknowledge the seq;
// EXPIRED is shown; OUT_OF_ORDER resends with `expectedSeq`; CLOCK_SKEW
// corrects the clock and resends (reminted if never sent); WRONG_CLIENT
// registers again, once.
//
// Prediction and rebase. The confirmed state is the replica. The view is the
// confirmed state with every pending write's prediction on top, re-run in
// order with its mutator over the state before it whenever the confirmed
// state or the pending writes change. When the server applies a write, its
// predicted records stay in the view, each until a log that holds it was
// read at the write's seq or later (the read carries `lastSeq`), so a record
// already in the confirmed state is never counted twice; a refused write is
// rolled back at once. A prediction that reads what the replica cannot know
// is `unknown`: shown as pending without a predicted effect.
//
// Reads of one log run one at a time (a pull, a resync, a thread's
// promotion), so an older answer is never applied over a newer one. A
// listener that throws is reported and does not stop a flush or a read.

import {
  StagedTx,
  inIndex,
  logsOf,
  memberKey,
  msToIso,
  predict,
  predictedView,
  refuse,
  type AnyMutator,
  type ApiError,
  type ErrorCode,
  type Index,
  type LogId,
  type StoredRecord,
} from "@session/mutators";

import { CLOCK_MAX_SKEW, ulid, webRandom } from "../ulid.js";
import {
  MAX_OPENED_THREADS,
  MAX_REPLACES,
  PROTOCOL_VERSION,
  UNRECORDED,
  type ApplyResult,
  type Change,
  type Clock,
  type Cursor,
  type Envelope,
  type LastSeq,
  type ReadOptions,
  type Snapshot,
  type SyncTransport,
  type Tier,
} from "../wire.js";

import { OverlaySource } from "./predict.js";
import { Replica, threadOf, type StorageAdapter } from "./replica.js";

/** How a read of a log ended. `dropped`: the log was dropped while the read
 * was in flight, and its answer was not applied. */
export type SyncOutcome = "snapshot" | "pull" | "resync" | "dropped";

/** What opening a thread came to (R3): held in full; not fetched (no
 * answer, a refused read, or the log was dropped meanwhile); or not served
 * by the server. */
export type OpenOutcome = "full" | "unavailable" | "missing";

/** The answer of `openMany`: each thread's outcome, and the error of the
 * read that failed, if one did (its `retryAfterMs` when the server named a
 * wait). */
export interface OpenMany {
  outcomes: Map<string, OpenOutcome>;
  error?: unknown;
}

/** The most thread ids one `threads` read names: the server takes at most
 * 100 ids in a request of `threads` reads. */
export const MAX_THREADS_PER_READ = 100;

/** How long the `queue` policy keeps a write (3 days, Y10). */
export const OUTBOX_TTL = 3 * 86_400_000;
/** The wait before a write is sent again after a transient answer: 1 s,
 * doubled for each further one, at most 10 minutes. */
export const RETRY_MIN = 1000;
export const RETRY_MAX = 600_000;
/** INTERNAL_SERVER_ERROR answers after which a write is marked failed. */
export const MAX_SERVER_ERRORS = 5;

/** The answers after which the client waits and sends the write again. */
const TRANSIENT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
]);

export type OutboxPolicy = "in-flight" | "queue";

/** What a pending write's prediction came to. */
export type PredictionState = "applied" | "refused" | "unknown";

/** A write in the outbox. It gets a client id and a seq when it is sent. */
export interface Pending {
  /** The write's local id, made when it was queued. It is never sent and
   * never changes, so the person's view of the write follows it. */
  local: string;
  mutationId: string;
  name: string;
  input: unknown;
  /** When it was queued, in the server's time as the client estimates it. */
  queuedAt: number;
  /** The device's own clock when it was queued, and whether the client's
   * clock was known to be right then (an answer's server time agreed with
   * it, or a correction was learned). A CLOCK_SKEW correction moves
   * `queuedAt` only by the error present when the write was queued: by the
   * new offset for a write queued on a clock not known to be right, unless
   * the device's clock went back since; not at all for one queued on a clock
   * known to be right (Y10). */
  rawAt: number;
  known: boolean;
  /** The mutation ids it had before the client reminted it. */
  replaces: string[];
  /** An envelope of it may have reached the server without a definite
   * answer: it keeps its mutation id from then on. */
  sent: boolean;
  /** Transient answers (or no answer) so far, and the INTERNAL_SERVER_ERROR
   * answers among them. */
  attempts: number;
  errors: number;
  /** Not sent again before this time (client time). */
  notBefore: number;
}

/** A write the client gave up on, shown to the person: `EXPIRED` (the
 * server's answer), `FAILED` (5 INTERNAL_SERVER_ERROR answers) or `DROPPED`
 * (still queued after 3 days). A write that was `sent` may have been applied. */
export interface Problem {
  local: string;
  mutationId: string;
  name: string;
  input: unknown;
  reason: "EXPIRED" | "FAILED" | "DROPPED";
  sent: boolean;
  /** Client time. */
  at: number;
}

/** State a device may keep between sessions (the `queue` policy; the web
 * client keeps none across a reload). */
export interface ClientState {
  /** The person the outbox and the client id belong to. */
  owner: string | null;
  clientId: string | null;
  outbox: Pending[];
  /** The last seq the server acknowledged for `clientId`. */
  acked: number;
  /** Milliseconds added to the device's clock, learned from CLOCK_SKEW. */
  offset: number;
  /** Whether the corrected clock was found right. */
  known?: boolean;
  problems: Problem[];
}

/** What happened to a write, for the person (02 §9.2). */
export type WriteEvent =
  | { type: "applied"; local: string; name: string; input: unknown; result: unknown }
  | { type: "refused"; local: string; name: string; input: unknown; error: ApiError }
  | { type: "unsent"; local: string; name: string; input: unknown; error: ApiError }
  | { type: "problem"; problem: Problem }
  | { type: "discarded"; local: string; name: string; input: unknown };

/** What the client tells the app besides writes: a protocol below the
 * server's minimum (reload, `01` S1); the end of the person's access to a
 * private space (R4: "You no longer have access to #name."); and a client
 * id the client registered itself (after WRONG_CLIENT), for the tab to keep
 * (`storeClientId`, Y3); and a session signed in as another person than the
 * client's (`user`: the handle signed in, null for none), found when the
 * client registered. The client then sends nothing more. */
export type ClientEvent =
  | WriteEvent
  | { type: "upgrade" }
  | { type: "left"; log: LogId; space: string; name: string }
  | { type: "client"; clientId: string; lastSeq: number }
  | { type: "user"; user: string | null };

export interface SyncClientOptions {
  /** The person this client reads and writes for; null: signed out. */
  user: string | null;
  clock: Clock;
  /** A number in [0, 1) for new ids. Default: Web Crypto. */
  random?: () => number;
  /** The mutator definitions, by name (the build's `MUTATORS`). */
  mutators: Readonly<Record<string, AnyMutator>>;
  /** The outbox policy (default `in-flight`, the web client's). */
  policy?: OutboxPolicy;
  /** Keep a person's own threads of a private space they lost access to
   * (the desktop's frozen copy; the suites). The web client keeps none (R4). */
  frozenCopies?: boolean;
  storage?: StorageAdapter;
  /** A client id `register` issued or re-attached (`clientIds.ts`), and the
   * last seq the server processed for it. */
  clientId?: string | null;
  lastSeq?: number;
  restore?: ClientState;
  /** The handle the session (the cookie) is signed in as now, null signed
   * out. Asked after `register` issued an id, when its answer names no
   * user, before anything is sent under that id. A rejection is no answer. */
  whoAmI?: () => Promise<string | null>;
}

/** Replace every string in `v` that `map` names. */
function remap(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === "string") return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => remap(x, map));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, map)]));
  return v;
}

/** What the client records when no answer arrived; `serverTime` is its own
 * estimate of the server's time (`now`). Nothing in it was said by the
 * server. */
const noAnswer = (now: number): ApplyResult => ({
  ok: false,
  error: {
    code: "SERVICE_UNAVAILABLE",
    message: "Couldn't reach Session. Check your connection and try again.",
    serverTime: now,
  },
});

/** The most envelopes and answers the client keeps for inspection
 * (`sent`, `answered`), and threads opened in a tab (R2). */
const HISTORY_MAX = 1000;
const OPENED_MAX = MAX_OPENED_THREADS;

/** A write after the server applied it: its predicted records, shown until
 * each one's log was read at the write's seq or later. */
interface Applied {
  p: Pending;
  seq: number;
  staged: Map<string, StoredRecord | null>;
}

/** Report an exception a listener threw, without letting it stop the
 * client (`reportError` in a browser). */
function report(e: unknown): void {
  const r = (globalThis as { reportError?: (e: unknown) => void }).reportError;
  if (r) r(e);
  else console.error(e);
}

/** Keep the newest `max` values of an array. */
function trim<T>(xs: T[], max: number): void {
  if (xs.length > max) xs.splice(0, xs.length - max);
}

/** Listener of the view: the keys that may have changed; `structural` when
 * what the replica holds changed shape (a log, a thread's tier, the outbox),
 * which can change what is known even when no key did. */
export type ViewListener = (changed: ReadonlySet<string>, info: { structural: boolean }) => void;

export class SyncClient {
  readonly replica: Replica;
  private readonly frozenCopies = new Map<LogId, Map<string, StoredRecord>>();
  private readonly outbox: Pending[];
  /** Writes whose request failed (`in-flight` policy): "Not sent". */
  private readonly unsentWrites: Pending[] = [];
  private appliedWrites: Applied[] = [];
  private readonly owner: string | null;
  private readonly shown: Problem[];
  private clientIdValue: string | null;
  private acked: number;
  private offset: number;
  private known: boolean;
  /** Milliseconds from the device's clock to the server's, learned from the
   * server time of every answer and read; null before the first. */
  private serverOffset: number | null = null;
  private readonly policy: OutboxPolicy;
  private readonly mutators: Readonly<Record<string, AnyMutator>>;
  private readonly random: () => number;
  /** The last seq the server reported as processed for this client. */
  lastSeq: LastSeq = null;
  /** The newest envelopes this client sent, in order (for the suites). */
  readonly sent: Envelope[] = [];
  /** The newest recorded answers this client got, in order, by local id. */
  readonly answered: { local: string; mutationId: string; name: string; result: ApplyResult }[] =
    [];
  private readonly lastAnswer = new WeakMap<Pending, ApplyResult>();
  /** The threads opened in this tab, served in full by a `window` snapshot
   * (R2), newest last. */
  private readonly opened = new Set<string>();
  private flushing: Promise<ApplyResult[]> | null = null;
  /** The write whose request is in flight. */
  private inFlight: Pending | null = null;
  /** Writes `send` waits for: never "Not sent", the caller has the answer. */
  private readonly sending = new Set<Pending>();
  /** Reads of each log, one at a time, in order. */
  private readonly reads = new Map<LogId, Promise<unknown>>();
  /** How many times each log was dropped: the answer of a read sent before
   * a drop is not applied. */
  private readonly drops = new Map<LogId, number>();
  /** How many reads moved each log's cursor (pulls and snapshots). */
  private readonly cursorReads = new Map<LogId, number>();
  /** The tier each log was last read with, for a resync. */
  private readonly tiers = new Map<LogId, Tier | undefined>();
  /** The session is signed in as another person: nothing more is sent. */
  private otherUser = false;

  // ---- the view ----
  private overlay = new Map<string, StoredRecord | null>();
  private readonly predictions = new Map<string, PredictionState>();
  /** Each predicted write's staged records (its view), by local id. */
  private readonly stagedOf = new Map<string, Map<string, StoredRecord | null>>();
  private stale = true;
  /** Counts the view's changes (a query re-runs when it was made before). */
  version = 0;
  private readonly listeners = new Set<ViewListener>();
  private readonly eventListeners = new Set<(e: ClientEvent) => void>();

  constructor(
    private readonly transport: SyncTransport,
    private readonly options: SyncClientOptions,
  ) {
    const restore = options.restore;
    this.owner = restore ? restore.owner : options.user;
    this.clientIdValue = restore?.clientId ?? options.clientId ?? null;
    this.outbox = (restore?.outbox ?? []).map((e) => ({ ...e, replaces: [...e.replaces] }));
    this.acked = restore?.acked ?? options.lastSeq ?? 0;
    this.offset = restore?.offset ?? 0;
    this.known = restore?.known ?? false;
    this.shown = (restore?.problems ?? []).map((x) => ({ ...x }));
    this.policy = options.policy ?? "in-flight";
    this.mutators = options.mutators;
    this.random = options.random ?? webRandom;
    this.replica = new Replica(options.storage);
  }

  get user(): string | null {
    return this.options.user;
  }

  get clientId(): string | null {
    return this.clientIdValue;
  }

  /** Whether `register` found the session signed in as another person, or
   * signed out: the client sends nothing more. */
  get sessionChanged(): boolean {
    return this.otherUser;
  }

  /** The client's time: its clock, corrected by the offset learned from
   * CLOCK_SKEW. Envelopes and new ids use it: the server measures the
   * device's clock by it (Y4), so it moves only on CLOCK_SKEW. */
  now(): number {
    return this.options.clock.now() + this.offset;
  }

  /** The server's time as the client estimates it from the server time of
   * its latest answer or read (the device's clock before any): for showing
   * times ("2 min ago") against server-stamped records. */
  serverNow(): number {
    return this.options.clock.now() + (this.serverOffset ?? this.offset);
  }

  private heard(serverTime: number | undefined) {
    if (typeof serverTime === "number" && serverTime > 0)
      this.serverOffset = serverTime - this.options.clock.now();
  }

  /** A new ULID at the client's time. */
  newId(): string {
    return ulid(this.now(), this.random);
  }

  private ownOutbox(): boolean {
    return this.owner === this.options.user;
  }

  // ---- events ----

  /** Listen for what happens to writes and access; returns the unsubscribe. */
  onEvent(listener: (e: ClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Tell every listener; a listener that throws is reported and the
   * others still hear, and the client goes on. */
  private emit(e: ClientEvent) {
    for (const f of [...this.eventListeners])
      try {
        f(e);
      } catch (x) {
        report(x);
      }
  }

  // ---- registration ----

  /** A client id: the one held, or a new one from the server (Y3). Never
   * for an outbox restored from another person's state. The error says
   * why there is none (no answer: SERVICE_UNAVAILABLE). */
  private async ensureClient(): Promise<
    { ok: true; clientId: string } | { ok: false; error: ApiError & { serverTime: number } }
  > {
    if (this.clientIdValue !== null) return { ok: true, clientId: this.clientIdValue };
    if (this.otherUser) return { ok: false, error: this.otherUserError() };
    if (!this.ownOutbox())
      return {
        ok: false,
        error: { ...refuse("WRONG_CLIENT").toError(), serverTime: this.now() },
      };
    let r: Awaited<ReturnType<SyncTransport["register"]>>;
    try {
      r = await this.transport.register();
    } catch {
      return {
        ok: false,
        error: (noAnswer(this.now()) as { error: ApiError & { serverTime: number } }).error,
      };
    }
    if (!r.ok)
      return { ok: false, error: { ...r.error, serverTime: r.error.serverTime ?? this.now() } };
    // The id is bound to whoever the session is signed in as now: another
    // tab may have signed in as someone else since this client was made.
    let user: string | null | undefined = r.user;
    if (user === undefined && this.options.whoAmI) {
      try {
        user = await this.options.whoAmI();
      } catch {
        return {
          ok: false,
          error: (noAnswer(this.now()) as { error: ApiError & { serverTime: number } }).error,
        };
      }
    }
    if (user !== undefined && user !== this.options.user) {
      if (!this.otherUser) {
        this.otherUser = true;
        this.emit({ type: "user", user });
      }
      return { ok: false, error: this.otherUserError() };
    }
    if (this.otherUser) return { ok: false, error: this.otherUserError() };
    const changed = this.clientIdValue !== r.clientId;
    this.clientIdValue = r.clientId;
    this.acked = r.lastSeq ?? 0;
    if (changed) {
      // the seqs read and applied so far were another id's
      this.appliedWrites = [];
      this.replica.resetSeqs();
      this.emit({ type: "client", clientId: r.clientId, lastSeq: this.acked });
    }
    return { ok: true, clientId: r.clientId };
  }

  private otherUserError(): ApiError & { serverTime: number } {
    return {
      code: "UNAUTHORIZED",
      message: "This tab is now signed in to another account. Reload to continue.",
      serverTime: this.now(),
    };
  }

  /** Get a client id from the server if there is none (Y3). */
  async register(): Promise<string | null> {
    const r = await this.ensureClient();
    return r.ok ? r.clientId : null;
  }

  /** The server does not know the client id (WRONG_CLIENT from the event
   * stream: expired, pruned, or another person's): forget it and register
   * again. */
  async reregister(): Promise<string | null> {
    this.clientIdValue = null;
    return this.register();
  }

  state(): ClientState {
    return {
      owner: this.owner,
      clientId: this.clientIdValue,
      outbox: this.outbox.map((e) => ({ ...e, replaces: [...e.replaces] })),
      acked: this.acked,
      offset: this.offset,
      known: this.known,
      problems: this.shown.map((x) => ({ ...x })),
    };
  }

  // ---- reads ----

  /** Learn the server's last processed seq for this client from a read. */
  private learn(lastSeq: LastSeq) {
    this.lastSeq = lastSeq;
    if (lastSeq !== null) this.acked = lastSeq;
  }

  private readOptions(tier?: Tier): ReadOptions {
    return {
      ...(tier ? { tier } : {}),
      ...(tier === "window" && this.opened.size ? { threads: [...this.opened] } : {}),
      ...(this.clientIdValue !== null ? { clientId: this.clientIdValue } : {}),
    };
  }

  /** Run reads of one log one at a time, in the order they were asked for,
   * so a later read never applies an older answer over a newer one. */
  private serial<T>(log: LogId, f: () => Promise<T>): Promise<T> {
    const before = this.reads.get(log) ?? Promise.resolve();
    const run = before.then(f, f);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.reads.set(log, settled);
    void settled.then(() => {
      if (this.reads.get(log) === settled) this.reads.delete(log);
    });
    return run;
  }

  /** Bring one log's replica up to date: a snapshot the first time and after
   * a resync, a pull otherwise. `tier` applies to the snapshot (R1, R2). */
  sync(log: LogId, tier?: Tier): Promise<SyncOutcome> {
    const drops = this.dropsOf(log);
    return this.serial(log, () =>
      this.dropsOf(log) === drops ? this.syncNow(log, tier) : Promise.resolve("dropped" as const),
    );
  }

  private dropsOf(log: LogId): number {
    return this.drops.get(log) ?? 0;
  }

  /** How many pulls and snapshots have moved a log's cursor (`receive`). */
  cursorReadsOf(log: LogId): number {
    return this.cursorReads.get(log) ?? 0;
  }

  private movedCursor(log: LogId) {
    this.cursorReads.set(log, this.cursorReadsOf(log) + 1);
  }

  private async syncNow(log: LogId, tier?: Tier): Promise<SyncOutcome> {
    const drops = this.dropsOf(log);
    const r = this.replica.state(log);
    if (r) {
      const res = await this.transport.pull(log, r.cursor, this.readOptions());
      this.heard(res.serverTime);
      // dropped while the pull was in flight: its answer is not applied
      if (this.dropsOf(log) !== drops) return "dropped";
      if (!("resync" in res)) {
        this.movedCursor(log);
        const changed = this.replica.applyPull(log, res.changes, res.cursor, res.lastSeq);
        this.learn(res.lastSeq);
        this.confirmed(changed, false);
        return "pull";
      }
    }
    const before = r ? new Map(r.records) : null;
    // a resync reads with the tier the log was read with
    const read = tier ?? (r ? this.tiers.get(log) : undefined);
    const snap = await this.transport.snapshot(log, this.readOptions(read));
    this.heard(snap.serverTime);
    if (this.dropsOf(log) !== drops) return "dropped";
    this.tiers.set(log, read);
    this.movedCursor(log);
    const after = new Map(snap.records.map((x) => [x.key, x.record]));
    if (before) this.lost(log, before, after);
    const frozen = this.frozenCopies.get(log);
    if (frozen) for (const k of after.keys()) frozen.delete(k);
    const changed = this.replica.applySnapshot(log, snap);
    this.learn(snap.lastSeq);
    this.confirmed(changed, true);
    return before ? "resync" : "snapshot";
  }

  /** After a resync of a private space the person is no longer a member of:
   * tell the app (R4), and keep what they wrote under their own threads when
   * the client keeps frozen copies. */
  private lost(log: LogId, before: Map<string, StoredRecord>, after: Map<string, StoredRecord>) {
    const me = this.options.user;
    if (!me || !log.startsWith("space:")) return;
    const sp = log.slice(6);
    const space = after.get(`space:${sp}`);
    if (space?.kind !== "space" || space.vis === "open" || after.has(memberKey(sp, me))) return;
    if (before.has(memberKey(sp, me)))
      this.emit({ type: "left", log, space: sp, name: space.name });
    if (!this.options.frozenCopies) return;
    const mine = new Set(
      [...before.values()].flatMap((x) => (x.kind === "thread" && x.u === me ? [x.id] : [])),
    );
    let frozen = this.frozenCopies.get(log);
    for (const [k, x] of before) {
      const th = threadOf(x);
      if (after.has(k) || th === null || !mine.has(th) || !("u" in x) || x.u !== me) continue;
      if (!frozen) this.frozenCopies.set(log, (frozen = new Map<string, StoredRecord>()));
      frozen.set(k, x);
    }
  }

  /** Open a thread (R3): a summary thread's full records are fetched with a
   * `threads` snapshot, in turn with the log's other reads, and kept for the
   * life of the tab. `unavailable` when the fetch fails (offline): the
   * summary is shown with "Couldn't load the rest of this thread." With `log`, the space log a
   * thread's address names (`/c/<name>?t=<id>`, `02` §2.1): a thread the
   * replica does not hold (older than the window) is fetched from that log
   * the same way when the replica holds the log. Without one, such a thread
   * is asked of every space log the replica holds (the protocol has no
   * lookup of a thread's log). `missing` when none of them serves it. */
  async open(thread: string, log?: LogId): Promise<OpenOutcome> {
    const held = this.replica.logOfThread(thread);
    const from = held
      ? [held]
      : log
        ? [log]
        : this.replica.logs().filter((l) => l.startsWith("space:"));
    if (from.length === 0) {
      this.remember([thread]);
      return "missing";
    }
    const answers = await Promise.all(from.map((l) => this.openMany(l, [thread])));
    const outcomes = answers.map((a) => a.outcomes.get(thread));
    if (outcomes.includes("full")) return "full";
    if (outcomes.includes("unavailable")) return "unavailable";
    return "missing";
  }

  /** Keep threads opened in this tab, served in full by a `window`
   * snapshot (R2), newest last. */
  private remember(threads: readonly string[]) {
    for (const th of threads) {
      this.opened.delete(th);
      this.opened.add(th);
    }
    for (const th of this.opened) {
      if (this.opened.size <= OPENED_MAX) break;
      this.opened.delete(th);
    }
  }

  /** Open several threads of one log (R3): one `threads` snapshot of the
   * ones not held in full, in turn with the log's other reads, at most
   * `MAX_THREADS_PER_READ` ids per read. A thread neither held nor served
   * is `missing`. The answer is not applied when the log was dropped while
   * the read was in flight (`unavailable`). */
  async openMany(log: LogId, threads: readonly string[]): Promise<OpenMany> {
    this.remember(threads);
    const outcomes = new Map<string, OpenOutcome>();
    const want: string[] = [];
    for (const th of new Set(threads)) {
      const held = this.replica.logOfThread(th);
      if (held && this.replica.isFull(held, th)) outcomes.set(th, "full");
      else want.push(th);
    }
    let error: unknown;
    const chunks: string[][] = [];
    for (let i = 0; i < want.length; i += MAX_THREADS_PER_READ)
      chunks.push(want.slice(i, i + MAX_THREADS_PER_READ));
    await Promise.all(
      chunks.map((chunk) => {
        const drops = this.dropsOf(log);
        return this.serial(log, async () => {
          const ask = chunk.filter((th) => {
            const held = this.replica.logOfThread(th);
            if (held && this.replica.isFull(held, th)) {
              outcomes.set(th, "full");
              return false;
            }
            return true;
          });
          if (ask.length === 0) return;
          const gone = () => this.dropsOf(log) !== drops || !this.replica.state(log);
          if (gone()) {
            for (const th of ask) outcomes.set(th, "unavailable");
            return;
          }
          let snap: Snapshot;
          try {
            snap = await this.transport.snapshot(log, {
              tier: "threads",
              threads: ask,
              ...(this.clientIdValue !== null ? { clientId: this.clientIdValue } : {}),
            });
          } catch (e) {
            error = e;
            for (const th of ask) outcomes.set(th, "unavailable");
            return;
          }
          this.heard(snap.serverTime);
          if (gone()) {
            for (const th of ask) outcomes.set(th, "unavailable");
            return;
          }
          const served = new Set(
            snap.records.flatMap((x) => (x.record.kind === "thread" ? [x.record.id] : [])),
          );
          const full: string[] = [];
          for (const th of ask) {
            const found = served.has(th) || this.replica.logOfThread(th) !== undefined;
            outcomes.set(th, found ? "full" : "missing");
            if (found) full.push(th);
          }
          this.confirmed(this.replica.addThreads(log, snap, full), true);
        });
      }),
    );
    return error === undefined ? { outcomes } : { outcomes, error };
  }

  /** Apply a batch of changes the server pushed for a log (the event stream,
   * `01` Y7) as a pull's answer, in turn with the log's other reads. Ignored
   * (false) when the replica no longer holds the log. */
  receive(
    log: LogId,
    batch: { changes: Change[]; cursor: Cursor; lastSeq: LastSeq; serverTime?: number },
    base?: number,
  ): Promise<boolean> {
    const drops = this.dropsOf(log);
    return this.serial(log, () => {
      if (!this.replica.state(log) || this.dropsOf(log) !== drops) return Promise.resolve(false);
      // `base`: the log's `cursorReadsOf` when the stream that pushed the
      // batch opened. A pull or snapshot since then may have read past the
      // batch (cursors are sealed: the client cannot compare them), and
      // applying the batch would move the cursor back and could bring back
      // a deleted record. Such a batch is not applied (false); the caller
      // reopens the stream from the newer cursor.
      if (base !== undefined && this.cursorReadsOf(log) !== base) return Promise.resolve(false);
      this.heard(batch.serverTime);
      const changed = this.replica.applyPull(log, batch.changes, batch.cursor, batch.lastSeq);
      this.learn(batch.lastSeq);
      this.confirmed(changed, false);
      return Promise.resolve(true);
    });
  }

  /** Forget a log (the person left a channel view, R5). A read of it in
   * flight is not applied when it answers. */
  dropLog(log: LogId): void {
    this.drops.set(log, this.dropsOf(log) + 1);
    this.tiers.delete(log);
    this.confirmed(this.replica.dropLog(log), true);
  }

  /** Take a write out of the outbox before it is sent. A write whose
   * request is in flight is not taken out (its answer is on its way). */
  drop(mutationId: string): boolean {
    const k = this.outbox.findIndex((p) => p.mutationId === mutationId);
    const p = this.outbox[k];
    if (!p || p === this.inFlight) return false;
    this.outbox.splice(k, 1);
    this.pendingChanged();
    return true;
  }

  records(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.replica.records(log);
  }

  /** The frozen copy of a space log: see `frozenCopies`. */
  frozen(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.frozenCopies.get(log) ?? new Map<string, StoredRecord>();
  }

  cursor(log: LogId): Cursor | undefined {
    return this.replica.state(log)?.cursor;
  }

  logs(): LogId[] {
    return this.replica.logs();
  }

  /** Every record this client holds in its live replicas, across its logs
   * (confirmed only). */
  allRecords(): Map<string, StoredRecord> {
    return new Map(this.replica.all());
  }

  // ---- the view (Y11) ----

  /** The record at `key` as the person sees it: confirmed, with the pending
   * writes' predictions on top. */
  get(key: string): StoredRecord | undefined {
    this.rebase();
    if (this.overlay.has(key)) return this.overlay.get(key) ?? undefined;
    return this.replica.get(key);
  }

  private source(): OverlaySource {
    this.rebase();
    return new OverlaySource(this.replica, this.overlay, this.options.user ?? "");
  }

  /** Whether the view can answer for `key`: it holds the record, or the log
   * that would hold it. False means unknown, not absent (an adapter answers
   * UNKNOWN). */
  loaded(key: string): boolean {
    return this.source().loaded(key);
  }

  /** Whether the view holds every record of an index: a space index needs
   * the space's log (in full for threads and what is under them), a thread
   * index the thread in full, a person index the person's own user log. */
  loadedIndex(kind: StoredRecord["kind"], index: Index): boolean {
    return this.source().loadedIndex(kind, index);
  }

  /** Every record as the person sees it. */
  view(): Map<string, StoredRecord> {
    this.rebase();
    const out = new Map(this.replica.all());
    for (const [k, r] of this.overlay) {
      if (r === null) out.delete(k);
      else out.set(k, r);
    }
    return out;
  }

  /** The keys of `kind` in an index as the person sees them, confirmed and
   * predicted, of what the replica holds (`loadedIndex` says whether that is
   * the whole index). */
  keysIn(kind: StoredRecord["kind"], index: Index): string[] {
    this.rebase();
    const keys = new Set(this.replica.keysIn(kind, index));
    for (const [k, r] of this.overlay) {
      if (r === null) keys.delete(k);
      else if (r.kind === kind && inIndex(r, index)) keys.add(k);
    }
    return [...keys];
  }

  /** The keys of `kind` as the person sees them (for `list` queries). */
  keysOfKind(kind: StoredRecord["kind"]): string[] {
    this.rebase();
    const keys = new Set(this.replica.keysOfKind(kind));
    for (const [k, r] of this.overlay) {
      if (r === null) keys.delete(k);
      else if (r.kind === kind) keys.add(k);
    }
    return [...keys];
  }

  /** What a pending write's prediction came to, by local id. */
  prediction(local: string): PredictionState | undefined {
    this.rebase();
    return this.predictions.get(local);
  }

  /** Listen for changes of the view: called once per confirming batch or
   * outbox change, with the keys that may have changed. A listener that
   * throws is reported, and the client goes on. */
  subscribe(listener: ViewListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The logs a record (or the record a key held) is written to, of those
   * the replica holds. */
  private heldLogs(key: string, r: StoredRecord | null): LogId[] {
    const rec = r ?? this.replica.get(key);
    if (!rec) return [];
    return logsOf(rec).filter((log) => this.replica.state(log) !== undefined);
  }

  /** Whether an applied write's record at `key` is in the confirmed state:
   * a log that holds it was read at the write's seq or later, or no log the
   * replica holds has it. */
  private covered(a: Applied, key: string, r: StoredRecord | null): boolean {
    const logs = this.heldLogs(key, r);
    return logs.length === 0 || logs.some((log) => (this.replica.state(log)?.seq ?? -1) >= a.seq);
  }

  /** Re-run every pending write's prediction over the confirmed state, on
   * top of the applied writes' records not confirmed yet. */
  private rebase() {
    if (!this.stale) return;
    this.stale = false;
    this.overlay = new Map();
    this.predictions.clear();
    this.stagedOf.clear();
    const me = this.options.user;
    if (me === null) return;
    for (const a of this.appliedWrites)
      for (const [k, r] of a.staged) if (!this.covered(a, k, r)) this.overlay.set(k, r);
    for (const p of [...this.outbox, ...this.unsentWrites]) {
      const def = Object.hasOwn(this.mutators, p.name) ? this.mutators[p.name] : undefined;
      if (!def) {
        this.predictions.set(p.local, "unknown");
        continue;
      }
      const source = new OverlaySource(this.replica, this.overlay, me);
      // stamped with the time it was queued: a rebase does not move it
      const tx = new StagedTx(source, me, msToIso(p.queuedAt), p.mutationId, "client");
      let state: PredictionState;
      try {
        const r = predict(tx, def, p.input);
        state = "unknown" in r ? "unknown" : r.ok ? "applied" : "refused";
      } catch {
        // a mutator bug on a replica: the write is sent unpredicted
        state = "unknown";
      }
      this.predictions.set(p.local, state);
      if (state !== "applied") continue;
      const staged = predictedView(tx);
      this.stagedOf.set(p.local, staged);
      for (const [k, r] of staged) this.overlay.set(k, r);
    }
  }

  /** The confirmed state changed: drop the applied writes whose records
   * are all confirmed, rebase, and tell the listeners. */
  private confirmed(changed: Set<string>, structural: boolean) {
    this.appliedWrites = this.appliedWrites.filter((a) =>
      [...a.staged].some(([k, r]) => !this.covered(a, k, r)),
    );
    this.notify(changed, structural);
  }

  private pendingChanged() {
    this.notify(new Set(), true);
  }

  private notify(changed: Set<string>, structural: boolean) {
    const old = this.overlay;
    this.stale = true;
    this.version++;
    if (!this.listeners.size) return;
    this.rebase();
    // the overlay's keys whose value changed
    for (const k of new Set([...old.keys(), ...this.overlay.keys()]))
      if (JSON.stringify(old.get(k)) !== JSON.stringify(this.overlay.get(k))) changed.add(k);
    if (!changed.size && !structural) return;
    for (const f of [...this.listeners])
      try {
        f(changed, { structural });
      } catch (x) {
        report(x);
      }
  }

  // ---- writes ----

  private push(name: string, input: unknown, mutationId: string): Pending {
    const now = this.now();
    const p: Pending = {
      local: ulid(now, this.random),
      mutationId,
      name,
      input,
      queuedAt: now,
      rawAt: this.options.clock.now(),
      known: this.known,
      replaces: [],
      sent: false,
      attempts: 0,
      errors: 0,
      notBefore: 0,
    };
    this.outbox.push(p);
    this.pendingChanged();
    return p;
  }

  private def(name: string): AnyMutator | undefined {
    return Object.hasOwn(this.mutators, name) ? this.mutators[name] : undefined;
  }

  /** Queue a write. Online-only mutators (`spaces.create`) are never queued. */
  queue(name: string, input: unknown, mutationId = this.newId()): Pending {
    if (this.def(name)?.online) throw new Error(`${name} is online only`);
    return this.push(name, input, mutationId);
  }

  /** Queue a write and send it now (the web client's writes). */
  write(name: string, input: unknown, mutationId = this.newId()): Pending {
    const p = this.queue(name, input, mutationId);
    void this.flush();
    return p;
  }

  pending(): readonly Pending[] {
    return this.outbox;
  }

  /** The writes whose request failed: "Not sent" (`in-flight` policy). */
  unsent(): readonly Pending[] {
    return this.unsentWrites;
  }

  /** The writes the client gave up on, for the person to see. */
  problems(): readonly Problem[] {
    return this.shown;
  }

  /** The person saw a problem: forget it. */
  dismiss(local: string): boolean {
    const k = this.shown.findIndex((x) => x.local === local);
    if (k < 0) return false;
    this.shown.splice(k, 1);
    return true;
  }

  /** Send a "Not sent" write again, with the same mutation id. */
  async retry(local: string): Promise<ApplyResult[]> {
    const k = this.unsentWrites.findIndex((p) => p.local === local);
    if (k < 0) return [];
    const [p] = this.unsentWrites.splice(k, 1);
    if (p) this.outbox.push(p);
    // the write is in flight again: no longer "Not sent"
    this.pendingChanged();
    return this.flush();
  }

  /** Drop a "Not sent" write and roll its prediction back. */
  discard(local: string): boolean {
    const k = this.unsentWrites.findIndex((p) => p.local === local);
    if (k < 0) return false;
    const [p] = this.unsentWrites.splice(k, 1);
    if (p) this.emit({ type: "discarded", local: p.local, name: p.name, input: p.input });
    this.pendingChanged();
    return true;
  }

  /** Take a write out of the outbox, wherever it is in it. */
  private remove(p: Pending) {
    const k = this.outbox.indexOf(p);
    if (k >= 0) this.outbox.splice(k, 1);
  }

  private giveUp(p: Pending, reason: Problem["reason"]) {
    this.remove(p);
    const problem: Problem = {
      local: p.local,
      mutationId: p.mutationId,
      name: p.name,
      input: p.input,
      reason,
      sent: p.sent,
      at: this.now(),
    };
    this.shown.push(problem);
    trim(this.shown, HISTORY_MAX);
    this.emit({ type: "problem", problem });
    this.pendingChanged();
  }

  /** Drop the writes queued more than `OUTBOX_TTL` ago (`queue` policy). */
  private expire() {
    if (this.policy !== "queue") return;
    const now = this.now();
    for (const p of [...this.outbox]) if (p.queuedAt < now - OUTBOX_TTL) this.giveUp(p, "DROPPED");
  }

  /** After the server refused the device's clock: a new mutation id and new
   * client-made ids, from the corrected clock, for every queued write that
   * was never sent. The writes that name those ids get the new ones too. */
  private remint() {
    const map = new Map<string, string>();
    for (const p of this.outbox) {
      if (p.sent) continue;
      const def = this.def(p.name);
      const parsed = def?.input.safeParse(p.input);
      for (const id of parsed?.success ? (def?.ids?.(parsed.data) ?? []) : [])
        map.set(id, this.newId());
      p.replaces.push(p.mutationId);
      // the newest ids only: the server takes at most `MAX_REPLACES`
      if (p.replaces.length > MAX_REPLACES) p.replaces.splice(0, p.replaces.length - MAX_REPLACES);
      p.mutationId = this.newId();
    }
    for (const x of this.outbox) if (!x.sent) x.input = remap(x.input, map);
  }

  /** A write's request failed (`in-flight` policy): "Not sent". A write
   * `send` waits for only leaves the outbox: its caller has the answer. */
  private notSent(p: Pending, res: ApplyResult) {
    this.remove(p);
    if (!this.sending.has(p)) {
      this.unsentWrites.push(p);
      if (!res.ok) {
        if (res.error.code === "UPGRADE_REQUIRED") this.emit({ type: "upgrade" });
        this.emit({
          type: "unsent",
          local: p.local,
          name: p.name,
          input: p.input,
          error: res.error,
        });
      }
    }
    this.pendingChanged();
  }

  /** Send the outbox in order, one answer per write sent. Concurrent calls
   * share one flush. */
  flush(): Promise<ApplyResult[]> {
    if (this.flushing) return this.flushing.then(() => this.flush());
    const run = this.flushOnce().finally(() => {
      this.flushing = null;
      this.inFlight = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    this.expire();
    if (!this.outbox.length) return out;
    const reg = await this.ensureClient();
    if (!reg.ok) {
      if (this.policy === "in-flight")
        for (const p of [...this.outbox]) this.notSent(p, { ok: false, error: reg.error });
      return out;
    }
    let clientId = reg.clientId;
    let skews = 0;
    let gaps = 0;
    let fresh = 0;
    while (this.outbox.length) {
      this.expire();
      const p = this.outbox[0];
      if (!p) break;
      const now = this.now();
      // waiting out its backoff; a wait longer than the longest backoff means
      // the device's clock went back, and the write is sent now
      if (p.notBefore > now && p.notBefore - now <= RETRY_MAX) break;
      const e: Envelope = {
        clientId,
        seq: this.acked + 1,
        mutationId: p.mutationId,
        ...(p.replaces.length ? { replaces: [...p.replaces] } : {}),
        name: p.name,
        input: structuredClone(p.input),
        protocolVersion: PROTOCOL_VERSION,
        clientTime: Math.max(0, Math.round(now)),
        queuedAt: Math.max(0, Math.round(p.queuedAt)),
      };
      this.sent.push(e);
      trim(this.sent, HISTORY_MAX);
      let res: ApplyResult;
      let answered = true;
      this.inFlight = p;
      try {
        res = await this.transport.apply(e);
      } catch {
        res = noAnswer(this.now());
        answered = false;
      } finally {
        this.inFlight = null;
      }
      this.lastAnswer.set(p, res);
      if (answered) {
        // an answer's server time that agrees with the client's clock: the
        // clock is known to be right (no answer says nothing about it)
        const at = res.ok ? res.serverTime : res.error.serverTime;
        if (Math.abs(at - this.now()) <= CLOCK_MAX_SKEW) this.known = true;
        this.heard(at);
      }
      if (!res.ok) {
        const { code, serverTime, expectedSeq } = res.error;
        if (code === "CLOCK_SKEW" && skews++ < 3) {
          const raw = this.options.clock.now();
          const offset = serverTime - raw;
          // a write not sent yet whose queue time was read from a clock not
          // known to be right moves by the correction; one queued on a clock
          // known to be right, or before the device's clock went back, keeps
          // its queue time: the error came later
          for (const x of this.outbox)
            if (!x.sent && !x.known && raw >= x.rawAt) x.queuedAt += offset - this.offset;
          this.offset = offset;
          this.known = true;
          this.remint();
          continue;
        }
        if (code === "OUT_OF_ORDER" && expectedSeq !== undefined && gaps++ < 3) {
          this.acked = expectedSeq - 1;
          continue;
        }
        if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 1) {
          // registered again: the app keeps the new id (a `client` event)
          this.clientIdValue = null;
          const again = await this.ensureClient();
          if (!again.ok) {
            out.push(res);
            // no id to send under (no answer, or the session is another
            // person's): this write and the ones behind it are Not sent
            if (this.policy === "in-flight")
              for (const x of [...this.outbox]) this.notSent(x, { ok: false, error: again.error });
            break;
          }
          clientId = again.clientId;
          continue;
        }
        if (this.policy === "in-flight" && UNRECORDED.has(code)) {
          // the request failed: "Not sent", and the writes behind it go on
          out.push(res);
          p.sent = true;
          this.notSent(p, res);
          // over the server's limit: the writes behind it would be refused
          // the same way, and are not sent into it
          if (code === "TOO_MANY_REQUESTS") for (const x of [...this.outbox]) this.notSent(x, res);
          skews = 0;
          gaps = 0;
          continue;
        }
        if (TRANSIENT.has(code)) {
          out.push(res);
          p.sent = true;
          p.attempts++;
          if (code === "INTERNAL_SERVER_ERROR") p.errors++;
          if (p.errors >= MAX_SERVER_ERRORS) {
            this.giveUp(p, "FAILED");
            skews = 0;
            gaps = 0;
            continue;
          }
          // the server's `Retry-After`, when longer than the backoff
          p.notBefore =
            now +
            Math.min(
              RETRY_MAX,
              Math.max(RETRY_MIN * 2 ** (p.attempts - 1), res.error.retryAfterMs ?? 0),
            );
          break;
        }
        if (UNRECORDED.has(code)) {
          if (code === "UPGRADE_REQUIRED") this.emit({ type: "upgrade" });
          out.push(res);
          break;
        }
      }
      // recorded: applied or refused. A replay used no seq (it was answered
      // before, under another envelope)
      out.push(res);
      if (!res.replay) this.acked = e.seq;
      // the staged records of its prediction, before it leaves the outbox
      this.rebase();
      const staged = this.stagedOf.get(p.local);
      this.remove(p);
      this.answered.push({ local: p.local, mutationId: p.mutationId, name: p.name, result: res });
      trim(this.answered, HISTORY_MAX);
      if (res.ok) {
        if (staged?.size)
          this.appliedWrites.push({ p, seq: res.replay ? this.acked : e.seq, staged });
        this.confirmed(new Set(), true);
        this.emit({
          type: "applied",
          local: p.local,
          name: p.name,
          input: p.input,
          result: res.result,
        });
      } else if (res.error.code === "EXPIRED") {
        p.sent = true;
        this.giveUp(p, "EXPIRED");
      } else {
        this.pendingChanged();
        this.emit({
          type: "refused",
          local: p.local,
          name: p.name,
          input: p.input,
          error: res.error,
        });
      }
      skews = 0;
      gaps = 0;
      if (res.ok && e.name === "threads.delete") this.unfreeze((e.input as { id: string }).id);
    }
    return out;
  }

  /** The person deleted a thread: drop its frozen copy. */
  private unfreeze(thread: string) {
    for (const frozen of this.frozenCopies.values())
      for (const [k, x] of frozen) if (threadOf(x) === thread) frozen.delete(k);
  }

  /** Send one write now, after the writes already queued (online-only
   * writes). Answers the write's own answer; a write that got no recorded
   * answer is not kept for later, and not shown as "Not sent". */
  async send(name: string, input: unknown, mutationId = this.newId()): Promise<ApplyResult> {
    const p = this.push(name, input, mutationId);
    this.sending.add(p);
    try {
      await this.flush();
    } finally {
      this.sending.delete(p);
    }
    // this write only: another queued write may carry the same mutation id
    this.remove(p);
    this.pendingChanged();
    return (
      this.lastAnswer.get(p) ?? {
        ok: false,
        error: {
          ...refuse(this.options.user === null ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE").toError(),
          serverTime: this.now(),
        },
      }
    );
  }
}
