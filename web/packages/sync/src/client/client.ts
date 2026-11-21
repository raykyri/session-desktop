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
// state or the pending writes change. A write the server applied stays
// pending until every replicated log was read at its seq or later (the read
// carries `lastSeq`); a refused one is rolled back at once. A prediction
// that reads what the replica cannot know is `unknown`: shown as pending
// without a predicted effect.

import {
  StagedTx,
  memberKey,
  msToIso,
  predict,
  predictedView,
  refuse,
  type AnyMutator,
  type ApiError,
  type ErrorCode,
  type LogId,
  type StoredRecord,
} from "@session/mutators";

import { CLOCK_MAX_SKEW, ulid, webRandom } from "../ulid.js";
import {
  MAX_REPLACES,
  PROTOCOL_VERSION,
  UNRECORDED,
  type ApplyResult,
  type Clock,
  type Cursor,
  type Envelope,
  type LastSeq,
  type ReadOptions,
  type SyncTransport,
  type Tier,
} from "../wire.js";

import { OverlaySource } from "./predict.js";
import { Replica, threadOf, type StorageAdapter } from "./replica.js";

export type SyncOutcome = "snapshot" | "pull" | "resync";

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
 * server's minimum (reload, `01` S1), and the end of the person's access to
 * a private space (R4: "You are no longer a member of #name."). */
export type ClientEvent =
  WriteEvent | { type: "upgrade" } | { type: "left"; log: LogId; space: string; name: string };

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
 * estimate of the server's time (`now`). */
const noAnswer = (now: number): ApplyResult => ({
  ok: false,
  error: { code: "SERVICE_UNAVAILABLE", message: "No answer from the server.", serverTime: now },
});

/** A pending write after the server applied it: kept in the view until the
 * replica has read every log at its seq. */
interface Applied {
  p: Pending;
  seq: number;
}

export class SyncClient {
  readonly replica: Replica;
  private readonly frozenCopies = new Map<LogId, Map<string, StoredRecord>>();
  private readonly outbox: Pending[];
  /** Writes whose request failed (`in-flight` policy): "Not sent". */
  private readonly unsentWrites: Pending[] = [];
  private readonly appliedWrites: Applied[] = [];
  private readonly owner: string | null;
  private readonly shown: Problem[];
  private clientIdValue: string | null;
  private acked: number;
  private offset: number;
  private known: boolean;
  private readonly policy: OutboxPolicy;
  private readonly mutators: Readonly<Record<string, AnyMutator>>;
  private readonly random: () => number;
  /** The last seq the server reported as processed for this client. */
  lastSeq: LastSeq = null;
  /** Every envelope this client sent, in order (for the suites). */
  readonly sent: Envelope[] = [];
  /** Every recorded answer this client got, in order, by local id. */
  readonly answered: { local: string; mutationId: string; name: string; result: ApplyResult }[] =
    [];
  private readonly lastAnswer = new Map<string, ApplyResult>();
  /** The threads opened in this tab, served in full by a `window` snapshot
   * (R2). */
  private readonly opened = new Set<string>();
  private flushing: Promise<ApplyResult[]> | null = null;

  // ---- the view ----
  private overlay = new Map<string, StoredRecord | null>();
  private readonly predictions = new Map<string, PredictionState>();
  private stale = true;
  private readonly listeners = new Set<(changed: ReadonlySet<string>) => void>();
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

  /** The client's time: its clock, corrected by what the server reported. */
  now(): number {
    return this.options.clock.now() + this.offset;
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

  private emit(e: ClientEvent) {
    for (const f of this.eventListeners) f(e);
  }

  // ---- registration ----

  /** Get a client id from the server if there is none: re-attach the one
   * the tab kept, or register a new one (Y3). Never for an outbox restored
   * from another person's state. */
  async register(): Promise<string | null> {
    if (this.clientIdValue === null && this.ownOutbox()) {
      const r = await this.transport.register();
      if (!r.ok) return null;
      this.clientIdValue = r.clientId;
      this.acked = r.lastSeq ?? 0;
    }
    return this.clientIdValue;
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

  /** Bring one log's replica up to date: a snapshot the first time and after
   * a resync, a pull otherwise. `tier` applies to the snapshot (R1, R2). */
  async sync(log: LogId, tier?: Tier): Promise<SyncOutcome> {
    const r = this.replica.state(log);
    if (r) {
      const res = await this.transport.pull(log, r.cursor, this.readOptions());
      if (!("resync" in res)) {
        const changed = this.replica.applyPull(log, res.changes, res.cursor, res.lastSeq);
        this.learn(res.lastSeq);
        this.confirmed(changed);
        return "pull";
      }
    }
    const before = r ? new Map(r.records) : null;
    const snap = await this.transport.snapshot(log, this.readOptions(tier));
    const after = new Map(snap.records.map((x) => [x.key, x.record]));
    if (before) this.lost(log, before, after);
    const frozen = this.frozenCopies.get(log);
    if (frozen) for (const k of after.keys()) frozen.delete(k);
    const changed = this.replica.applySnapshot(log, snap);
    this.learn(snap.lastSeq);
    this.confirmed(changed);
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
   * `threads` snapshot and kept for the life of the tab. `unavailable` when
   * the fetch fails (offline): the summary is shown, "Available when
   * online". */
  async open(thread: string): Promise<"full" | "unavailable"> {
    this.opened.add(thread);
    const log = this.replica.logOfThread(thread);
    if (!log || this.replica.isFull(log, thread)) return "full";
    try {
      const snap = await this.transport.snapshot(log, {
        tier: "threads",
        threads: [thread],
        ...(this.clientIdValue !== null ? { clientId: this.clientIdValue } : {}),
      });
      this.confirmed(this.replica.addThreads(log, snap, [thread]));
      return "full";
    } catch {
      return "unavailable";
    }
  }

  /** Forget a log (the person left a channel view, R5). */
  dropLog(log: LogId): void {
    this.confirmed(this.replica.dropLog(log));
  }

  /** Take a write out of the outbox before it is sent. */
  drop(mutationId: string): boolean {
    const k = this.outbox.findIndex((p) => p.mutationId === mutationId);
    if (k < 0) return false;
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
   * outbox change, with the keys that may have changed. */
  subscribe(listener: (changed: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The writes in view order: applied awaiting their pull, queued, not sent. */
  private viewWrites(): Pending[] {
    return [...this.appliedWrites.map((a) => a.p), ...this.outbox, ...this.unsentWrites];
  }

  /** Re-run every pending write's prediction over the confirmed state. */
  private rebase() {
    if (!this.stale) return;
    this.stale = false;
    this.overlay = new Map();
    this.predictions.clear();
    const me = this.options.user;
    if (me === null) return;
    for (const p of this.viewWrites()) {
      const def = Object.hasOwn(this.mutators, p.name) ? this.mutators[p.name] : undefined;
      if (!def) {
        this.predictions.set(p.local, "unknown");
        continue;
      }
      const source = new OverlaySource(this.replica, this.overlay, me);
      const tx = new StagedTx(source, me, msToIso(this.now()), p.mutationId, "client");
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
      for (const [k, r] of predictedView(tx)) this.overlay.set(k, r);
    }
  }

  /** The confirmed state changed: drop applied writes every log has read,
   * rebase, and tell the listeners. */
  private confirmed(changed: Set<string>) {
    const logs = this.replica.logs();
    for (let k = this.appliedWrites.length - 1; k >= 0; k--) {
      const a = this.appliedWrites[k] as Applied;
      if (logs.every((log) => (this.replica.state(log)?.seq ?? -1) >= a.seq))
        this.appliedWrites.splice(k, 1);
    }
    this.notify(changed);
  }

  private pendingChanged() {
    this.notify(new Set());
  }

  private notify(changed: Set<string>) {
    const old = this.overlay;
    this.stale = true;
    if (!this.listeners.size) return;
    this.rebase();
    for (const k of old.keys()) changed.add(k);
    for (const k of this.overlay.keys()) changed.add(k);
    if (!changed.size) return;
    for (const f of this.listeners) f(changed);
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

  /** Send a "Not sent" write again, with the same mutation id. */
  async retry(local: string): Promise<ApplyResult[]> {
    const k = this.unsentWrites.findIndex((p) => p.local === local);
    if (k < 0) return [];
    const [p] = this.unsentWrites.splice(k, 1);
    if (p) this.outbox.push(p);
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

  private giveUp(p: Pending, reason: Problem["reason"]) {
    const k = this.outbox.indexOf(p);
    if (k >= 0) this.outbox.splice(k, 1);
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

  /** A write's request failed (`in-flight` policy): "Not sent". */
  private notSent(p: Pending, res: ApplyResult) {
    const k = this.outbox.indexOf(p);
    if (k >= 0) this.outbox.splice(k, 1);
    this.unsentWrites.push(p);
    if (!res.ok) {
      if (res.error.code === "UPGRADE_REQUIRED") this.emit({ type: "upgrade" });
      this.emit({ type: "unsent", local: p.local, name: p.name, input: p.input, error: res.error });
    }
    this.pendingChanged();
  }

  /** Send the outbox in order, one answer per write sent. Concurrent calls
   * share one flush. */
  flush(): Promise<ApplyResult[]> {
    if (this.flushing) return this.flushing.then(() => this.flush());
    const run = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    this.expire();
    if (!this.outbox.length) return out;
    let clientId = await this.register();
    if (clientId === null) {
      if (this.policy === "in-flight")
        for (const p of [...this.outbox])
          this.notSent(p, {
            ok: false,
            error: { ...refuse("UNAUTHORIZED").toError(), serverTime: this.now() },
          });
      return out;
    }
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
      let res: ApplyResult;
      try {
        res = await this.transport.apply(e);
      } catch {
        res = noAnswer(this.now());
      }
      this.lastAnswer.set(p.local, res);
      // an answer's server time that agrees with the client's clock: the
      // clock is known to be right
      const at = res.ok ? res.serverTime : res.error.serverTime;
      if (Math.abs(at - this.now()) <= CLOCK_MAX_SKEW) this.known = true;
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
          this.clientIdValue = null;
          const id = await this.register();
          if (id === null) {
            out.push(res);
            break;
          }
          clientId = id;
          continue;
        }
        if (this.policy === "in-flight" && UNRECORDED.has(code)) {
          // the request failed: "Not sent", and the writes behind it go on
          out.push(res);
          p.sent = true;
          this.notSent(p, res);
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
          p.notBefore = now + Math.min(RETRY_MAX, RETRY_MIN * 2 ** (p.attempts - 1));
          break;
        }
        if (UNRECORDED.has(code)) {
          if (code === "UPGRADE_REQUIRED") this.emit({ type: "upgrade" });
          out.push(res);
          break;
        }
      }
      // recorded: applied or refused
      out.push(res);
      this.acked = e.seq;
      this.outbox.shift();
      this.answered.push({ local: p.local, mutationId: p.mutationId, name: p.name, result: res });
      if (res.ok) {
        this.appliedWrites.push({ p, seq: e.seq });
        this.emit({
          type: "applied",
          local: p.local,
          name: p.name,
          input: p.input,
          result: res.result,
        });
        this.confirmed(new Set());
      } else if (res.error.code === "EXPIRED") {
        p.sent = true;
        this.giveUp(p, "EXPIRED");
      } else {
        this.emit({
          type: "refused",
          local: p.local,
          name: p.name,
          input: p.input,
          error: res.error,
        });
        this.pendingChanged();
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
   * answer is not kept for later. */
  async send(name: string, input: unknown, mutationId = this.newId()): Promise<ApplyResult> {
    const p = this.push(name, input, mutationId);
    await this.flush();
    // this write only: another queued write may carry the same mutation id
    const k = this.outbox.indexOf(p);
    if (k >= 0) this.outbox.splice(k, 1);
    const u = this.unsentWrites.indexOf(p);
    if (u >= 0) this.unsentWrites.splice(u, 1);
    this.pendingChanged();
    return (
      this.lastAnswer.get(p.local) ?? {
        ok: false,
        error: {
          ...refuse(this.options.user === null ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE").toError(),
          serverTime: this.now(),
        },
      }
    );
  }
}
