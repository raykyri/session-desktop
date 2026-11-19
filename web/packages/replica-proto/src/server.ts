// The prototype server half: a multi-user in-memory store with one change-log
// table, `register` and `apply` (in order per client, idempotent by user and
// mutation id), and `snapshot` and `pull` filtered by the reader's scope at
// the time of the read.
//
// Apply, in order. "Unrecorded" answers use up nothing: the client may send
// the same `seq` again.
//   envelope shape (BAD_REQUEST) and protocol version (UPGRADE_REQUIRED): unrecorded
//   signed in with a valid handle (UNAUTHORIZED): unrecorded
//   the client id is the caller's (WRONG_CLIENT): unrecorded
//   a stored result for (user, mutation id) whose payload digest matches:
//     returned as it is, under any client id or seq; nothing runs and no seq
//     is used
//   a result stored for (client, seq) with the same mutation id and payload:
//     returned as it is
//   `seq` is the client's next one (OUT_OF_ORDER, with `expectedSeq`): unrecorded
//   the mutation id is a ULID, and not one the user sent with another
//     payload (BAD_REQUEST): uses up the `seq`, stored for (client, seq), so
//     a malformed or reused id never enters the (user, mutation id) table
//   the mutation id is inside the time window (CLOCK_SKEW, with the server's
//     time): unrecorded
//   the mutator name and its strict input schema
//   the input's ids are inside the time window (CLOCK_SKEW): unrecorded
//   an online-only mutator's mutation id is at most a minute old (CLOCK_SKEW):
//     unrecorded
//   ban, who and can, pre (server values), run
// A refusal from these stages is recorded unless its code is in UNRECORDED;
// an exception that is not a refusal is INTERNAL_SERVER_ERROR, unrecorded,
// and nothing it staged is written. A recorded result is committed in one
// step with the write's changes and its post-commit effects (queued): stored
// for 7 days with a digest of the name and input, and the client's last
// processed `seq` becomes this one. The queued effects run after that commit,
// and are tried again on every later call until they succeed.
//
// Change log: one row per (log, key), holding key, op and version only; a
// write replaces the key's row. Versions come from one sequence for the whole
// server, so the version a reader gets back says nothing about one space.
// A pull reads each changed record as it is now. A deleted record leaves a
// tombstone (its last state, used only to decide who gets the `del`) for 30
// days.
//
// Resync: a pull answers `{ resync: true }` when the cursor's epoch is not
// the log's (a space's visibility changed) or its version is from before the
// epoch began, its version is unknown or older than 30 days, or the reader's
// own membership of the space changed after it.

import { z } from "zod";

import { canRead, isClosed, spaceRec, view } from "./access.js";
import {
  MIN_PROTOCOL_VERSION,
  UNRECORDED,
  type Actor,
  type ApplyResult,
  type Change,
  type Cursor,
  type LastSeq,
  type LogRow,
  type Pull,
  type ReadOptions,
  type RegisterResult,
  type ServerOptions,
  type Snapshot,
  type TestServer,
} from "./contract.js";
import {
  MUTATORS,
  Refusal,
  authorize,
  isHandle,
  refuse,
  type AnyMutator,
  type Effect,
  type NotifDraft,
  type PreCtx,
  type Tx,
} from "./mutators.js";
import {
  audienceOf,
  createdOf,
  idOf,
  keyOf,
  logsOf,
  memberKey,
  type Draft,
  type LogId,
  type Kind,
  type RecordOf,
  type StoredRecord,
} from "./records.js";
import { DAY, MINUTE, deriveId, digest, inWindow, isUlid, ulid, ulidTime } from "./ulid.js";

export const DEDUP_TTL = 7 * DAY;
export const TOMBSTONE_TTL = 30 * DAY;
/** The most an online-only write's mutation id may be behind the server's
 * time: older, it waited in an outbox. */
export const ONLINE_MAX_AGE = MINUTE;

const envelopeS = z.strictObject({
  clientId: z.string(),
  seq: z.number().int().positive(),
  mutationId: z.string(),
  name: z.string(),
  input: z.unknown(),
  protocolVersion: z.number().int(),
});
type Env = z.infer<typeof envelopeS>;
const cursorS = z.strictObject({ epoch: z.string(), version: z.number().int().nonnegative() });
const logS = z.string().regex(/^(space|user):[^:]+$/);

const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const fail = (e: Refusal): ApplyResult => ({ ok: false, error: e.toError() });
const same = (a: StoredRecord, b: StoredRecord) =>
  JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });
const byCreated = (a: { key: string; record: StoredRecord }, b: typeof a) => {
  const x = createdOf(a.record);
  const y = createdOf(b.record);
  return x < y ? -1 : x > y ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

/** JSON with object keys sorted, so equal values print equally. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

/** The id-collision answer: one message, whether or not the caller may read
 * the record that holds the id. */
const ID_TAKEN = "An item with this id exists.";

class Store {
  readonly records = new Map<string, StoredRecord>();
  readonly byKind = new Map<Kind, Set<string>>();
  readonly tombs = new Map<string, { rec: StoredRecord; at: number }>();
  /** Every id ever written, deleted records included: an id is never reused. */
  readonly ids = new Set<string>();
  readonly logs = new Map<LogId, Map<string, LogRow>>();
  /** A log's epoch and the version it began at (absent: "e0", from 0). */
  readonly epochs = new Map<LogId, { id: string; start: number }>();
  /** The commit time of each version, never decreasing; version 0 is the
   * store's start. */
  readonly times: number[];
  head = 0;

  constructor(now: number) {
    this.times = [now];
  }

  get(key: string) {
    return this.records.get(key);
  }

  keysOf(kind: Kind): Iterable<string> {
    return this.byKind.get(kind) ?? [];
  }

  epoch(log: LogId) {
    return this.epochs.get(log) ?? { id: "e0", start: 0 };
  }

  private row(log: LogId, key: string, op: "put" | "del", version: number) {
    let rows = this.logs.get(log);
    if (!rows) this.logs.set(log, (rows = new Map<string, LogRow>()));
    rows.delete(key);
    rows.set(key, { key, op, version });
  }

  /** Write staged records under one new version. Returns the version, or null
   * when nothing changed. */
  commit(staged: Map<string, StoredRecord | null>, now: number): number | null {
    const writes: [string, StoredRecord | null, StoredRecord | undefined][] = [];
    for (const [key, next] of staged) {
      const prev = this.records.get(key);
      if (next === null ? !prev : prev && same(prev, next)) continue;
      writes.push([key, next, prev]);
    }
    if (!writes.length) return null;
    const version = ++this.head;
    // a version's time is never before the last one's, so the tombstone
    // cutoff and the cursor cutoff compare the same order
    this.times[version] = Math.max(now, this.times[version - 1] ?? now);
    const at = this.times[version];
    for (const [key, next, prev] of writes) {
      if (next === null) {
        const old = prev as StoredRecord;
        this.records.delete(key);
        this.byKind.get(old.kind)?.delete(key);
        this.tombs.set(key, { rec: old, at });
        for (const log of logsOf(old)) this.row(log, key, "del", version);
        continue;
      }
      const rev = (prev?.rev ?? this.tombs.get(key)?.rec.rev ?? 0) + 1;
      const rec = { ...next, rev };
      this.records.set(key, rec);
      let kind = this.byKind.get(rec.kind);
      if (!kind) this.byKind.set(rec.kind, (kind = new Set<string>()));
      kind.add(key);
      this.tombs.delete(key);
      const id = idOf(rec);
      if (id !== null) this.ids.add(id);
      for (const log of logsOf(rec)) this.row(log, key, "put", version);
      // who may read a space's records depends on whether it is closed: a
      // change replaces the log's history (every cursor resyncs)
      if (rec.kind === "space" && prev?.kind === "space" && isClosed(prev) !== isClosed(rec))
        this.epochs.set(`space:${rec.id}`, { id: `e${version}`, start: version });
    }
    return version;
  }

  /** Drop the tombstones (and their `del` rows) committed strictly before the
   * cutoff. A cursor at the cutoff itself is still served (`pull`), so a
   * delete committed in the same millisecond as that cursor is kept. */
  prune(now: number) {
    const cutoff = now - TOMBSTONE_TTL;
    for (const [key, t] of this.tombs) {
      if (t.at >= cutoff) continue;
      this.tombs.delete(key);
      for (const log of logsOf(t.rec)) {
        const rows = this.logs.get(log);
        if (rows?.get(key)?.op === "del") rows.delete(key);
      }
    }
  }
}

class StagedTx implements Tx {
  readonly staged = new Map<string, StoredRecord | null>();
  private readonly newIds = new Set<string>();

  constructor(
    private readonly store: Store,
    readonly me: string,
    readonly now: string,
    private readonly mutationId: string,
  ) {}

  get(key: string): StoredRecord | undefined {
    if (this.staged.has(key)) return this.staged.get(key) ?? undefined;
    return this.store.get(key);
  }

  find<K extends Kind>(kind: K, pred?: (r: RecordOf<K>) => boolean): RecordOf<K>[] {
    const keys = new Set(this.store.keysOf(kind));
    for (const [key, r] of this.staged) if (r?.kind === kind) keys.add(key);
    const out: RecordOf<K>[] = [];
    for (const key of [...keys].sort()) {
      const r = this.get(key);
      if (r?.kind === kind && (!pred || pred(r as RecordOf<K>))) out.push(r as RecordOf<K>);
    }
    return out;
  }

  create(r: Draft): void {
    const key = keyOf(r);
    const id = idOf(r);
    if (this.get(key) || (id !== null && (this.store.ids.has(id) || this.newIds.has(id))))
      throw refuse("CONFLICT", ID_TAKEN);
    this.write(key, r);
    if (id !== null) this.newIds.add(id);
  }

  put(r: Draft): void {
    const key = keyOf(r);
    const prev = this.get(key);
    if (!prev && idOf(r) !== null) return this.create(r);
    if (prev && audienceOf(prev) !== audienceOf(r))
      throw new Error(`a write changed the audience of ${key}`);
    this.write(key, r);
  }

  del(key: string): void {
    if (this.get(key)) this.staged.set(key, null);
  }

  id(ordinal: number): string {
    return deriveId(this.me, this.mutationId, ordinal);
  }

  private write(key: string, r: Draft) {
    this.staged.set(key, { ...r, rev: 0 });
  }
}

/** What `execute` decided: the answer, whether it is recorded, and for an
 * applied write the staged changes and the effects to queue. */
interface Outcome {
  result: ApplyResult;
  recorded: boolean;
  staged?: Map<string, StoredRecord | null>;
  effects?: Effect[];
}

/** A registered client: the user it is bound to, its last processed seq,
 * and the answers recorded under its seqs (a mutation id that is malformed
 * or already used for another change has no (user, mutation id) entry). */
interface ClientRec {
  u: string;
  last: number;
  answers: Map<number, { digest: string; result: ApplyResult; at: number }>;
}

/** One entry of the effect queue: kept until the effect has run. */
interface QueuedEffect {
  effect: Effect;
  /** The commit time of the write that queued it. */
  at: number;
  attempts: number;
}

export class ProtoServer implements TestServer {
  private readonly store: Store;
  private readonly dedup = new Map<string, { result: ApplyResult; digest: string; at: number }>();
  private readonly clients = new Map<string, ClientRec>();
  /** The post-commit effects not yet run, in commit order: written in the
   * same step as the write that queued them (durable with it), and removed
   * once they ran. */
  private readonly effectQueue: QueuedEffect[] = [];
  private readonly jobList: { kind: string; id: string }[] = [];
  private readonly clock: ServerOptions["clock"];
  private readonly random: () => number;
  private readonly mutators: Readonly<Record<string, AnyMutator>>;

  constructor(options: ServerOptions) {
    this.clock = options.clock;
    this.random = options.random ?? Math.random;
    this.mutators = options.mutators ?? MUTATORS;
    this.store = new Store(this.clock.now());
  }

  /** The caller's handle, or null for a signed-out caller and for a handle no
   * person may have. */
  private userOf(actor: Actor | null): string | null {
    return actor !== null && typeof actor.u === "string" && isHandle(actor.u) ? actor.u : null;
  }

  // ---- writes ----

  register(actor: Actor | null): RegisterResult {
    this.housekeep(this.clock.now());
    const u = this.userOf(actor);
    if (u === null) return { ok: false, error: refuse("UNAUTHORIZED").toError() };
    let id: string;
    do id = ulid(this.clock.now(), this.random);
    while (this.clients.has(id));
    this.clients.set(id, { u, last: 0, answers: new Map() });
    return { ok: true, clientId: id };
  }

  apply(actor: Actor | null, envelope: unknown): ApplyResult {
    const env = envelopeS.safeParse(envelope);
    if (!env.success)
      return fail(
        refuse("BAD_REQUEST", undefined, [
          "envelope: expected { clientId, seq, mutationId, name, input, protocolVersion }",
        ]),
      );
    const m = env.data;
    if (m.protocolVersion < MIN_PROTOCOL_VERSION)
      return fail(
        refuse("UPGRADE_REQUIRED", undefined, [
          `protocolVersion: expected at least ${MIN_PROTOCOL_VERSION}`,
        ]),
      );
    const u = this.userOf(actor);
    if (u === null) return fail(refuse("UNAUTHORIZED"));
    const client = this.clients.get(m.clientId);
    if (!client || client.u !== u) return fail(refuse("WRONG_CLIENT"));
    const now = this.clock.now();
    this.housekeep(now);
    const wellFormed = isUlid(m.mutationId);
    const dk = `${u}\u0000${m.mutationId}`;
    const payload = digest(canonical([m.name, m.input]));
    const hit = wellFormed ? this.dedup.get(dk) : undefined;
    // a write this user's devices sent before, under any client id or seq:
    // its recorded answer, and the seq is not used (R7c)
    if (hit && hit.digest === payload) return structuredClone(hit.result);
    // an answer recorded under this client's seq: the same envelope again
    const sent = digest(canonical([m.mutationId, m.name, m.input]));
    const kept = client.answers.get(m.seq);
    if (kept && kept.digest === sent) return structuredClone(kept.result);
    if (m.seq !== client.last + 1)
      return {
        ok: false,
        error: {
          ...refuse("OUT_OF_ORDER", undefined, [`seq: expected ${client.last + 1}`]).toError(),
          expectedSeq: client.last + 1,
        },
      };
    if (!wellFormed || hit) {
      // uses the seq, so it is recorded with it, under (client, seq): a
      // malformed id never enters the (user, mutation id) table, and a used
      // one keeps its first answer there (R7b)
      const result = fail(
        refuse("BAD_REQUEST", undefined, [
          wellFormed
            ? "mutationId: already used for a different change"
            : "mutationId: expected a ULID",
        ]),
      );
      client.answers.set(m.seq, { digest: sent, result, at: now });
      client.last = m.seq;
      return structuredClone(result);
    }
    const out = this.execute(u, m, now);
    if (out.recorded) {
      // one step, with nothing in it that can fail: the record changes, the
      // queued effects, the stored answer and the client's seq (R9). On the
      // real server, one transaction.
      if (out.staged) this.store.commit(out.staged, now);
      for (const effect of out.effects ?? [])
        this.effectQueue.push({ effect, at: now, attempts: 0 });
      this.dedup.set(dk, { result: out.result, digest: payload, at: now });
      client.last = m.seq;
    }
    this.runEffects(now);
    return structuredClone(out.result);
  }

  private execute(u: string, m: Env, now: number): Outcome {
    const final = (e: Refusal): Outcome => ({ result: fail(e), recorded: !UNRECORDED.has(e.code) });
    const skew = (issue: string): Outcome => ({
      result: {
        ok: false,
        error: {
          code: "CLOCK_SKEW",
          message: refuse("CLOCK_SKEW").message,
          issues: [issue],
          serverTime: now,
        },
      },
      recorded: false,
    });
    const window = (path: string) =>
      skew(`${path}: expected a ULID from the past 4 days to 1 minute ahead`);
    if (!inWindow(m.mutationId, now)) return window("mutationId");
    const def = Object.hasOwn(this.mutators, m.name) ? this.mutators[m.name] : undefined;
    if (!def)
      return final(refuse("NOT_FOUND", "The server has no procedure with this name.", ["name"]));
    const parsed = def.input.safeParse(m.input);
    if (!parsed.success)
      return final(
        refuse(
          "BAD_REQUEST",
          undefined,
          parsed.error.issues.map(
            (x) => `input${x.path.map((p) => `.${String(p)}`).join("")}: ${x.code}`,
          ),
        ),
      );
    const input = parsed.data;
    try {
      for (const id of def.ids?.(input) ?? []) if (!inWindow(id, now)) return window("input.id");
      // an online-only write whose mutation id is over a minute old: the
      // client's clock is behind, or the write waited in an outbox. Either
      // way the client corrects its clock and sends it again with a new
      // mutation id (R6: a slow clock could never create a space).
      if (def.online && ulidTime(m.mutationId) < now - ONLINE_MAX_AGE)
        return skew("mutationId: expected a ULID from the past minute (online only)");
      const tx = new StagedTx(this.store, u, isoAt(now), m.mutationId);
      authorize(tx, def, input);
      const pre: PreCtx = {
        now,
        random: this.random,
        inviteCodeTaken: (code) =>
          [...this.store.keysOf("invite")].some(
            (k) => (this.store.get(k) as RecordOf<"invite">).code === code,
          ),
      };
      const values = def.pre?.(pre, input) ?? {};
      const result = def.run(tx, input, values);
      const effects = def.post?.(input, result) ?? [];
      return { result: { ok: true, result }, recorded: true, staged: tx.staged, effects };
    } catch (e) {
      if (e instanceof Refusal) return final(e);
      // not a refusal: a fault of the server, not of the input. Nothing is
      // written or recorded; the client sends the write again later (R8).
      return final(refuse("INTERNAL_SERVER_ERROR"));
    }
  }

  /** Run the queued effects, oldest first. One that fails stays queued and
   * is tried again on the next call; its write's answer is already
   * recorded and does not change. */
  private runEffects(now: number) {
    for (let k = 0; k < this.effectQueue.length;) {
      const q = this.effectQueue[k] as QueuedEffect;
      try {
        this.runEffect(q.effect, now);
        this.effectQueue.splice(k, 1);
      } catch {
        q.attempts++;
        k++;
      }
    }
  }

  private runEffect(effect: Effect, now: number) {
    if (effect.type === "job") {
      this.jobList.push({ kind: effect.kind, id: effect.id });
      return;
    }
    const staged = new Map<string, StoredRecord | null>();
    const staff = spaceRec(this.store, effect.sp)?.mods ?? [];
    for (const [to, role] of staff) {
      if (role === "member") continue;
      let id: string;
      do id = ulid(now, this.random);
      while (this.store.ids.has(id) || staged.has(`notif:${id}`));
      const n: NotifDraft = {
        to,
        type: "report",
        sp: effect.sp,
        report: effect.report,
        item: effect.item,
      };
      staged.set(`notif:${id}`, {
        ...n,
        kind: "notif",
        id,
        read: false,
        createdAt: isoAt(now),
        rev: 0,
      });
    }
    this.store.commit(staged, now);
  }

  /** Expire what is past its lifetime, and run the queued effects. */
  private housekeep(now: number) {
    this.store.prune(now);
    for (const [k, d] of this.dedup) if (d.at <= now - DEDUP_TTL) this.dedup.delete(k);
    for (const c of this.clients.values())
      for (const [seq, a] of c.answers) if (a.at <= now - DEDUP_TTL) c.answers.delete(seq);
    this.runEffects(now);
  }

  // ---- reads ----

  private rows(log: LogId) {
    return this.store.logs.get(log) ?? new Map<string, LogRow>();
  }

  /** A user log is read by its user only; anyone else, and a signed-out
   * caller, gets nothing from it. */
  private closedTo(log: LogId, u: string | null) {
    return log.startsWith("user:") && log !== `user:${u}`;
  }

  private lastSeq(u: string | null, clientId: string | undefined): LastSeq {
    if (u === null || clientId === undefined) return null;
    const c = this.clients.get(clientId);
    return c && c.u === u ? c.last : null;
  }

  snapshot(actor: Actor | null, log: LogId, options: ReadOptions = {}): Snapshot {
    const now = this.clock.now();
    this.housekeep(now);
    const u = this.userOf(actor);
    const out: Snapshot = {
      records: [],
      version: this.store.head,
      epoch: this.store.epoch(log).id,
      lastSeq: this.lastSeq(u, options.clientId),
    };
    if (!logS.safeParse(log).success || this.closedTo(log, u)) return out;
    for (const row of this.rows(log).values()) {
      if (row.op !== "put") continue;
      const rec = this.store.get(row.key);
      if (!rec) continue;
      if (
        options.tier === "summary" &&
        (rec.kind === "followup" || rec.kind === "reply" || rec.kind === "run")
      )
        continue;
      const v = view(this.store, rec, u);
      if (v) out.records.push({ key: row.key, record: structuredClone(v) });
    }
    // the server's creation time orders a list, never the time a client put
    // in an id
    out.records.sort(byCreated);
    return out;
  }

  pull(actor: Actor | null, log: LogId, cursor: Cursor, options: ReadOptions = {}): Pull {
    const now = this.clock.now();
    this.housekeep(now);
    const u = this.userOf(actor);
    const c = cursorS.safeParse(cursor);
    if (!logS.safeParse(log).success || !c.success) return { resync: true };
    const { epoch, version } = c.data;
    const current = this.store.epoch(log);
    if (epoch !== current.id || version < current.start || version > this.store.head)
      return { resync: true };
    if ((this.store.times[version] ?? 0) < now - TOMBSTONE_TTL) return { resync: true };
    const head = {
      version: this.store.head,
      epoch,
      lastSeq: this.lastSeq(u, options.clientId),
    };
    if (this.closedTo(log, u)) return { changes: [], ...head };
    const rows = this.rows(log);
    if (u !== null && log.startsWith("space:")) {
      const mine = rows.get(memberKey(log.slice(6), u));
      if (mine && mine.version > version) return { resync: true };
    }
    const changes: Change[] = [];
    const fresh = [...rows.values()]
      .filter((r) => r.version > version)
      .sort((a, b) => a.version - b.version);
    for (const row of fresh) {
      if (row.op === "put") {
        const rec = this.store.get(row.key);
        const v = rec && view(this.store, rec, u);
        if (v) changes.push({ key: row.key, op: "put", record: structuredClone(v) });
      } else {
        const t = this.store.tombs.get(row.key);
        if (t && canRead(this.store, t.rec, u)) changes.push({ key: row.key, op: "del" });
      }
    }
    return { changes, ...head };
  }

  // ---- test access ----

  dump(): ReadonlyMap<string, StoredRecord> {
    return this.store.records;
  }

  logRows(log: LogId): LogRow[] {
    this.housekeep(this.clock.now());
    return [...this.rows(log).values()].map((r) => ({ ...r }));
  }

  jobs() {
    return this.jobList;
  }
}

export const createProtoServer = (options: ServerOptions): TestServer => new ProtoServer(options);
