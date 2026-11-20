// A minimal client for the suite: one replica per log, built from a snapshot
// and kept current with pulls, and an outbox sent in order. It does not
// predict or rebase (phase 0).
//
// A client belongs to one actor for its lifetime: it has no way to change the
// person it reads for, so a replica never holds what another person read. Its
// client id, from `register`, is bound to that person on the server too, so
// an outbox restored under another person's sign-in is refused, and the
// client never registers a new id for an outbox that is not its actor's.
//
// The outbox holds writes without a `seq`. A write gets its seq when it is
// sent: the last seq the server acknowledged for this client + 1. So a write
// dropped from the outbox (expired after 3 days, failed, or cancelled) leaves
// no gap (review round 1, R7). Writes are sent one at a time, in queue order.
// Each envelope carries `clientTime`, the client's clock corrected by the
// offset it learned from the server, and `queuedAt`, when the write was
// queued on the same clock.
//
// A write's identity: its mutation id. Once an envelope of a write may have
// reached the server without a definite answer (no answer arrived, or a
// transient one), the write keeps its mutation id for good, so a resend is
// either the stored answer or, if the server no longer has it, EXPIRED; it is
// never applied a second time (review round 2, finding 3). Only a write that
// was never sent that way gets new ids after CLOCK_SKEW, and its envelope
// lists the mutation ids it had before in `replaces`, so the server stores
// its answer under them too.
//
// Answers:
// - recorded (applied or refused): the seq is acknowledged, the write leaves
//   the outbox. EXPIRED is recorded: the write is also shown to the person
//   (`problems`).
// - OUT_OF_ORDER: the server has no answer recorded for this mutation id
//   (contract.ts, `UNRECORDED`), and says which seq it takes next; the
//   client sends the same write again with it. This covers a stored answer
//   that was replayed without using the seq (after a new client id, R7c).
// - CLOCK_SKEW: the client corrects its clock from the server's time and
//   sends the write again (with new ids, if it was never sent).
// - WRONG_CLIENT (the client id expired): the client registers again and
//   sends the write again under the new id; a stored answer replays under
//   any client id.
// - TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR, or no
//   answer: the write stays at the head of the outbox and the flush stops.
//   The client sends it again after 1 s, 2 s, 4 s, … up to 10 minutes. After
//   5 INTERNAL_SERVER_ERROR answers the write is marked failed, shown to the
//   person, and the writes behind it are sent (decision 5 of review round 1).
// - any other unrecorded answer: the flush stops.
// A write still queued 3 days after it was queued (in the server's time, as
// the client estimates it) is dropped and shown to the person.

import {
  PROTOCOL_VERSION,
  UNRECORDED,
  type Actor,
  type ApplyResult,
  type Clock,
  type Cursor,
  type Envelope,
  type ErrorCode,
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

/** A queued write. It gets a client id and a seq when it is sent. */
export interface Pending {
  /** The write's local id, made when it was queued. It is never sent and
   * never changes, so the person's view of the write follows it across new
   * mutation ids. */
  local: string;
  mutationId: string;
  name: string;
  input: unknown;
  /** When it was queued, in the server's time as the client estimates it
   * (its clock plus the learned offset). */
  queuedAt: number;
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

/** State a device keeps on disk between sessions, for the suite to restore. */
export interface ClientState {
  /** The person the outbox and the client id belong to. */
  owner: string | null;
  clientId: string | null;
  outbox: Pending[];
  /** The last seq the server acknowledged for `clientId`. */
  acked: number;
  /** Milliseconds added to the device's clock, learned from CLOCK_SKEW. */
  offset: number;
  problems: Problem[];
}

/** The thread a record belongs to: its own id for a thread, else its `th`. */
const threadOf = (r: StoredRecord): string | null =>
  r.kind === "thread"
    ? r.id
    : r.kind === "node" ||
        r.kind === "reply" ||
        r.kind === "comment" ||
        r.kind === "run" ||
        r.kind === "answer"
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

const noAnswer = (): ApplyResult => ({
  ok: false,
  error: { code: "SERVICE_UNAVAILABLE", message: "No answer from the server." },
});

export class ReplicaClient {
  private readonly replicas = new Map<LogId, Replica>();
  /** Per space log: the caller's own threads, with the nodes, replies
   * and runs the caller wrote under them, as the replica last held them, kept
   * after the caller lost read access to the space. The server sends no
   * further updates for them. Other people's nodes and replies are not
   * kept: AGENTS.md has a device replicate nothing of a closed space its
   * user does not belong to, and the owner's exception covers the user's own
   * threads only. */
  private readonly frozenCopies = new Map<LogId, Map<string, StoredRecord>>();
  private readonly outbox: Pending[];
  private readonly owner: string | null;
  private readonly shown: Problem[];
  private clientIdValue: string | null;
  /** The last seq the server acknowledged for this client id: from recorded
   * answers, OUT_OF_ORDER's `expectedSeq` and reads' `lastSeq`. */
  private acked: number;
  /** Milliseconds to add to the local clock, learned from CLOCK_SKEW. */
  private offset: number;
  /** The last seq the server reported as processed for this client. */
  lastSeq: LastSeq = null;
  /** Every envelope this client sent, in order (for the suite). */
  readonly sent: Envelope[] = [];
  /** Every recorded answer this client got, in order, by local id (for the
   * suite; the person's view of each write). */
  readonly answered: { local: string; mutationId: string; name: string; result: ApplyResult }[] =
    [];
  /** The last answer each write got, recorded or not, by local id. */
  private readonly lastAnswer = new Map<string, ApplyResult>();

  constructor(
    private readonly server: ServerHalf,
    readonly actor: Actor | null,
    private readonly env: { clock: Clock; random: () => number },
    restore?: ClientState,
  ) {
    this.owner = restore ? restore.owner : (actor?.u ?? null);
    this.clientIdValue = restore?.clientId ?? null;
    this.outbox = (restore?.outbox ?? []).map((e) => ({ ...e, replaces: [...e.replaces] }));
    this.acked = restore?.acked ?? 0;
    this.offset = restore?.offset ?? 0;
    this.shown = (restore?.problems ?? []).map((x) => ({ ...x }));
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

  /** Whether the outbox and client id are this client's actor's. */
  private ownOutbox(): boolean {
    return this.owner === (this.actor?.u ?? null);
  }

  /** Get a client id from the server, if there is none. Never for an outbox
   * restored from another person's state. */
  async register(): Promise<string | null> {
    if (this.clientIdValue === null && this.ownOutbox()) {
      const r = await this.server.register(this.actor);
      if (!r.ok) return null;
      this.clientIdValue = r.clientId;
      this.acked = 0;
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
      problems: this.shown.map((x) => ({ ...x })),
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
        r.cursor = res.cursor;
        this.learn(res.lastSeq);
        return "pull";
      }
    }
    const snap = await this.server.snapshot(this.actor, log, this.readOptions(tier));
    const records = new Map(snap.records.map((x) => [x.key, x.record]));
    if (r) this.freeze(log, r.records, records);
    const frozen = this.frozenCopies.get(log);
    if (frozen) for (const k of records.keys()) frozen.delete(k);
    this.replicas.set(log, { cursor: snap.cursor, records });
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
    return this.replicas.get(log)?.cursor;
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
    const now = this.now();
    const p: Pending = {
      local: ulid(now, this.env.random),
      mutationId,
      name,
      input,
      queuedAt: now,
      replaces: [],
      sent: false,
      attempts: 0,
      errors: 0,
      notBefore: 0,
    };
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

  /** The writes the client gave up on, for the person to see. */
  problems(): readonly Problem[] {
    return this.shown;
  }

  /** Take a write out of the outbox before it is sent (the person cancelled
   * it). The writes after it are not held up: they get their seqs when sent. */
  drop(mutationId: string): boolean {
    const k = this.outbox.findIndex((p) => p.mutationId === mutationId);
    if (k < 0) return false;
    this.outbox.splice(k, 1);
    return true;
  }

  private giveUp(p: Pending, reason: Problem["reason"]) {
    const k = this.outbox.indexOf(p);
    if (k >= 0) this.outbox.splice(k, 1);
    this.shown.push({
      local: p.local,
      mutationId: p.mutationId,
      name: p.name,
      input: p.input,
      reason,
      sent: p.sent,
      at: this.now(),
    });
  }

  /** Drop the writes queued more than `OUTBOX_TTL` ago, and show them. */
  private expire() {
    const now = this.now();
    for (const p of [...this.outbox]) if (p.queuedAt < now - OUTBOX_TTL) this.giveUp(p, "DROPPED");
  }

  /** After the server refused the device's clock: a new mutation id and new
   * client-made ids, from the corrected clock, for every queued write that
   * was never sent (their ids came from the clock that was off). The writes
   * that name those ids get the new ones too. A write that was sent keeps
   * its ids. An envelope of a reminted write lists its earlier mutation ids
   * in `replaces`: one of them may have reached the server after all. */
  private remint() {
    const map = new Map<string, string>();
    for (const p of this.outbox) {
      if (p.sent) continue;
      const def = Object.hasOwn(MUTATORS, p.name) ? MUTATORS[p.name] : undefined;
      const parsed = def?.input.safeParse(p.input);
      for (const id of parsed?.success ? (def?.ids?.(parsed.data) ?? []) : [])
        map.set(id, this.newId());
      p.replaces.push(p.mutationId);
      p.mutationId = this.newId();
    }
    for (const x of this.outbox) if (!x.sent) x.input = remap(x.input, map);
  }

  /** Send the outbox in order, one answer per write sent (see the answers
   * above). A write waiting out its backoff stops the flush. CLOCK_SKEW and
   * OUT_OF_ORDER are first answered by sending the write again, up to 3
   * times each, and WRONG_CLIENT by registering again, once. */
  async flush(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    this.expire();
    if (!this.outbox.length) return out;
    let clientId = await this.register();
    if (clientId === null) return out;
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
        res = await this.server.apply(this.actor, e);
      } catch {
        res = noAnswer();
      }
      this.lastAnswer.set(p.local, res);
      if (!res.ok) {
        const { code, serverTime, expectedSeq } = res.error;
        if (code === "CLOCK_SKEW" && serverTime !== undefined && skews++ < 3) {
          this.offset = serverTime - this.env.clock.now();
          // a queue time ahead of the corrected clock was read from the
          // clock that was off; one behind it may be right (the clock went
          // wrong after the write was queued), so it stays
          const corrected = this.now();
          for (const x of this.outbox) x.queuedAt = Math.min(x.queuedAt, corrected);
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
          out.push(res);
          break;
        }
      }
      // recorded: applied or refused
      out.push(res);
      this.acked = e.seq;
      this.outbox.shift();
      this.answered.push({ local: p.local, mutationId: p.mutationId, name: p.name, result: res });
      if (!res.ok && res.error.code === "EXPIRED") {
        p.sent = true;
        this.giveUp(p, "EXPIRED");
      }
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
   * writes). Answers the write's own answer; a write that got no recorded
   * answer is not kept for later. */
  async send(name: string, input: unknown, mutationId = this.newId()): Promise<ApplyResult> {
    const p = this.push(name, input, mutationId);
    await this.flush();
    // this write only: another queued write may carry the same mutation id
    const k = this.outbox.indexOf(p);
    if (k >= 0) this.outbox.splice(k, 1);
    return (
      this.lastAnswer.get(p.local) ?? {
        ok: false,
        error: refuse(this.actor === null ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE").toError(),
      }
    );
  }
}
