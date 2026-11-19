// A minimal client for the suite: one replica per log, built from a snapshot
// and kept current with pulls, and an outbox sent in order. It does not
// predict or rebase (phase 0).
//
// A client belongs to one actor for its lifetime: it has no way to change the
// person it reads for, so a replica never holds what another person read. Its
// client id, from `register`, is bound to that person on the server too, so
// an outbox restored under another person's sign-in is refused.
//
// The outbox holds writes without a `seq`. A write gets its seq when it is
// sent: the last seq the server acknowledged for this client + 1. So a write
// dropped from the outbox (expired after 3 days, or cancelled) leaves no gap
// (review round 1, R7). Writes are sent one at a time, in queue order.
//
// Answers:
// - recorded (applied or refused): the seq is acknowledged, the write leaves
//   the outbox.
// - OUT_OF_ORDER: the server has no answer recorded for this mutation id
//   (contract.ts, `UNRECORDED`), and says which seq it takes next; the
//   client sends the same write again with it. This covers a stored answer
//   that was replayed without using the seq (after a new client id, R7c).
// - CLOCK_SKEW: the client corrects its clock from the server's time and
//   sends the write again with new ids.
// - any other unrecorded answer, the transient ones included
//   (TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR): the write
//   stays at the head of the outbox and the flush stops (R15).

import {
  PROTOCOL_VERSION,
  UNRECORDED,
  type Actor,
  type ApplyResult,
  type Clock,
  type Cursor,
  type Envelope,
  type LastSeq,
  type ServerHalf,
  type Tier,
} from "./contract.js";
import { MUTATORS, refuse } from "./mutators.js";
import { memberKey, type LogId, type StoredRecord } from "./records.js";
import { ulid } from "./ulid.js";

interface Replica {
  cursor: Cursor;
  records: Map<string, StoredRecord>;
}

export type SyncOutcome = "snapshot" | "pull" | "resync";

/** How long the outbox keeps a write (AGENTS.md: 3 days). */
export const OUTBOX_TTL = 3 * 86_400_000;

/** A queued write: no client id or seq yet; it gets both when it is sent.
 * `queuedAt` is the client's time when it was queued. */
export interface Pending {
  mutationId: string;
  name: string;
  input: unknown;
  queuedAt: number;
}

/** State a device keeps on disk between sessions, for the suite to restore.
 * `acked`: the last seq the server acknowledged for `clientId` (absent: 0). */
export interface ClientState {
  clientId: string | null;
  outbox: Pending[];
  acked?: number;
}

/** The thread a record belongs to: its own id for a thread, else its `th`. */
const threadOf = (r: StoredRecord): string | null =>
  r.kind === "thread"
    ? r.id
    : r.kind === "followup" || r.kind === "reply" || r.kind === "run"
      ? r.th
      : null;

/** Replace every string in `v` that `map` names. */
function remap(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === "string") return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => remap(x, map));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, map)]));
  return v;
}

export class ReplicaClient {
  private readonly replicas = new Map<LogId, Replica>();
  /** Per space log: the caller's own threads, with the follow-ups, replies
   * and runs the caller wrote under them, as the replica last held them, kept
   * after the caller lost read access to the space. The server sends no
   * further updates for them. Other people's follow-ups and replies are not
   * kept: AGENTS.md has a device replicate nothing of a closed space its
   * user does not belong to, and the owner's exception covers the user's own
   * threads only. */
  private readonly frozenCopies = new Map<LogId, Map<string, StoredRecord>>();
  private readonly outbox: Pending[];
  private clientIdValue: string | null;
  /** The last seq the server acknowledged for this client id: from recorded
   * answers, OUT_OF_ORDER's `expectedSeq` and reads' `lastSeq`. */
  private acked: number;
  /** Milliseconds to add to the local clock, learned from CLOCK_SKEW. */
  private offset = 0;
  /** The last seq the server reported as processed for this client. */
  lastSeq: LastSeq = null;
  /** Every envelope this client sent, in order (for the suite). */
  readonly sent: Envelope[] = [];

  constructor(
    private readonly server: ServerHalf,
    readonly actor: Actor | null,
    private readonly env: { clock: Clock; random: () => number },
    restore?: ClientState,
  ) {
    this.clientIdValue = restore?.clientId ?? null;
    this.outbox = restore
      ? restore.outbox.map((e) => ({
          mutationId: e.mutationId,
          name: e.name,
          input: e.input,
          queuedAt: e.queuedAt,
        }))
      : [];
    this.acked = restore?.acked ?? 0;
  }

  get clientId(): string | null {
    return this.clientIdValue;
  }

  /** The client's time: its clock, corrected by what the server reported. */
  now(): number {
    return this.env.clock.now() + this.offset;
  }

  /** A new ULID at the client's time. */
  newId(): string {
    return ulid(this.now(), this.env.random);
  }

  /** Get a client id from the server once. */
  async register(): Promise<string | null> {
    if (this.clientIdValue === null) {
      const r = await this.server.register(this.actor);
      if (!r.ok) return null;
      this.clientIdValue = r.clientId;
      this.acked = 0;
    }
    return this.clientIdValue;
  }

  state(): ClientState {
    return {
      clientId: this.clientIdValue,
      outbox: this.outbox.map((e) => ({ ...e })),
      acked: this.acked,
    };
  }

  /** Learn the server's last processed seq for this client from a read. */
  private learn(lastSeq: LastSeq) {
    this.lastSeq = lastSeq;
    if (lastSeq !== null) this.acked = lastSeq;
  }

  private readOptions(tier?: Tier) {
    return {
      ...(tier ? { tier } : {}),
      ...(this.clientIdValue !== null ? { clientId: this.clientIdValue } : {}),
    };
  }

  /** Bring one log's replica up to date: a snapshot the first time and after
   * a resync, a pull otherwise. */
  async sync(log: LogId, tier?: Tier): Promise<SyncOutcome> {
    const r = this.replicas.get(log);
    if (r) {
      const res = await this.server.pull(this.actor, log, r.cursor, this.readOptions());
      if (!("resync" in res)) {
        for (const c of res.changes) {
          if (c.op === "put") r.records.set(c.key, c.record);
          else r.records.delete(c.key);
        }
        r.cursor = { epoch: res.epoch, version: res.version };
        this.learn(res.lastSeq);
        return "pull";
      }
    }
    const snap = await this.server.snapshot(this.actor, log, this.readOptions(tier));
    const records = new Map(snap.records.map((x) => [x.key, x.record]));
    if (r) this.freeze(log, r.records, records);
    const frozen = this.frozenCopies.get(log);
    if (frozen) for (const k of records.keys()) frozen.delete(k);
    this.replicas.set(log, { cursor: { epoch: snap.epoch, version: snap.version }, records });
    this.learn(snap.lastSeq);
    return r ? "resync" : "snapshot";
  }

  /** After a resync of a closed space the caller is no longer a member of:
   * keep what the caller wrote under their own threads. */
  private freeze(log: LogId, before: Map<string, StoredRecord>, after: Map<string, StoredRecord>) {
    const me = this.actor?.u;
    if (!me || !log.startsWith("space:")) return;
    const sp = log.slice(6);
    const space = after.get(`space:${sp}`);
    if (space?.kind !== "space" || space.vis === "open" || after.has(memberKey(sp, me))) return;
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

  records(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.replicas.get(log)?.records ?? new Map<string, StoredRecord>();
  }

  /** The frozen copy of a space log: see `frozenCopies`. */
  frozen(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.frozenCopies.get(log) ?? new Map<string, StoredRecord>();
  }

  cursor(log: LogId): Cursor | undefined {
    const c = this.replicas.get(log)?.cursor;
    return c && { ...c };
  }

  logs(): LogId[] {
    return [...this.replicas.keys()];
  }

  /** Every record this client holds in its live replicas, across its logs. */
  allRecords(): Map<string, StoredRecord> {
    const out = new Map<string, StoredRecord>();
    for (const r of this.replicas.values()) for (const [k, v] of r.records) out.set(k, v);
    return out;
  }

  private push(name: string, input: unknown, mutationId: string): Pending {
    const p: Pending = { mutationId, name, input, queuedAt: this.now() };
    this.outbox.push(p);
    return p;
  }

  /** Queue a write. Online-only mutators (`spaces.create`) are never queued. */
  queue(name: string, input: unknown, mutationId = this.newId()): Pending {
    if (Object.hasOwn(MUTATORS, name) && MUTATORS[name]?.online)
      throw new Error(`${name} is online only`);
    return this.push(name, input, mutationId);
  }

  pending(): readonly Pending[] {
    return this.outbox;
  }

  /** Take a write out of the outbox before it is sent (the person cancelled
   * it). The writes after it are not held up: they get their seqs when sent. */
  drop(mutationId: string): boolean {
    const k = this.outbox.findIndex((p) => p.mutationId === mutationId);
    if (k < 0) return false;
    this.outbox.splice(k, 1);
    return true;
  }

  /** New mutation id and new client-made ids for the write at the head of
   * the outbox, after the server refused its ids' times. The writes queued
   * after it that name those ids get the new ones too. */
  private remint(p: Pending) {
    const def = Object.hasOwn(MUTATORS, p.name) ? MUTATORS[p.name] : undefined;
    const parsed = def?.input.safeParse(p.input);
    const map = new Map<string, string>();
    for (const id of parsed?.success ? (def?.ids?.(parsed.data) ?? []) : [])
      map.set(id, this.newId());
    p.mutationId = this.newId();
    for (const x of this.outbox) x.input = remap(x.input, map);
  }

  /** Send the outbox in order, one answer per write sent. Writes older than
   * `OUTBOX_TTL` are dropped first. A write the server did not record stops
   * the flush and stays queued; CLOCK_SKEW and OUT_OF_ORDER are first
   * answered by sending the write again (new ids from the corrected clock;
   * the seq the server expects), up to 3 times each. */
  async flush(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    const now = this.now();
    for (let k = this.outbox.length - 1; k >= 0; k--)
      if ((this.outbox[k] as Pending).queuedAt < now - OUTBOX_TTL) this.outbox.splice(k, 1);
    if (!this.outbox.length) return out;
    const clientId = await this.register();
    if (clientId === null) return out;
    let skews = 0;
    let gaps = 0;
    while (this.outbox.length) {
      const p = this.outbox[0] as Pending;
      const e: Envelope = {
        clientId,
        seq: this.acked + 1,
        mutationId: p.mutationId,
        name: p.name,
        input: structuredClone(p.input),
        protocolVersion: PROTOCOL_VERSION,
      };
      this.sent.push(e);
      const res = await this.server.apply(this.actor, e);
      if (!res.ok && res.error.code === "CLOCK_SKEW" && res.error.serverTime !== undefined) {
        if (skews++ < 3) {
          this.offset = res.error.serverTime - this.env.clock.now();
          this.remint(p);
          continue;
        }
      }
      if (!res.ok && res.error.code === "OUT_OF_ORDER" && res.error.expectedSeq !== undefined) {
        if (gaps++ < 3) {
          this.acked = res.error.expectedSeq - 1;
          continue;
        }
      }
      out.push(res);
      if (!res.ok && UNRECORDED.has(res.error.code)) break;
      this.acked = e.seq;
      this.outbox.shift();
      skews = 0;
      gaps = 0;
      if (res.ok && e.name === "threads.delete") this.unfreeze((e.input as { id: string }).id);
    }
    return out;
  }

  /** The caller deleted a thread: drop its frozen copy. */
  private unfreeze(thread: string) {
    for (const frozen of this.frozenCopies.values())
      for (const [k, x] of frozen) if (threadOf(x) === thread) frozen.delete(k);
  }

  /** Send one write now, after the writes already queued (online-only
   * writes). Answers the write's result. */
  async send(name: string, input: unknown, mutationId = this.newId()): Promise<ApplyResult> {
    const p = this.push(name, input, mutationId);
    const results = await this.flush();
    // not sent, or answered with an unrecorded code: it is not kept for later
    this.drop(p.mutationId);
    return results.at(-1) ?? { ok: false, error: refuse("UNAUTHORIZED").toError() };
  }
}
