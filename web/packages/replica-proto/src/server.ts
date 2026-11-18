// The prototype server half: a multi-user in-memory store with one change-log
// table, `apply` (idempotent by user and mutation id), and `snapshot` and
// `pull` filtered by the reader's scope at the time of the read.
//
// Apply, in order:
//   envelope shape and protocol version (not recorded: the client retries)
//   signed in (UNAUTHORIZED, not recorded)
//   a stored result for (user, mutation id): returned as it is, nothing runs
//   the mutation id: a ULID inside the time window
//   the mutator name and its strict input schema; the input's ids: inside the window
//   who and can, pre (server values), run, commit, post
// The result, applied or refused, is stored for 7 days and becomes the user's
// last mutation id.
//
// Change log: one row per (log, key), holding key, op and version only; a
// write replaces the key's row. Versions come from one sequence for the whole
// server, so the version a reader gets back says nothing about one space.
// A pull reads each changed record as it is now. A deleted record leaves a
// tombstone (its last state, used only to decide who gets the `del`) for 30
// days.
//
// Resync: a pull answers `{ resync: true }` when the cursor's epoch is not
// the log's (a space's visibility changed), its version is unknown or older
// than 30 days, or the reader's own membership of the space changed after it.

import { z } from "zod";

import { canRead, isClosed, view } from "./access.js";
import {
  MIN_PROTOCOL_VERSION,
  type Actor,
  type ApplyResult,
  type Change,
  type Cursor,
  type LogRow,
  type Pull,
  type ServerOptions,
  type Snapshot,
  type TestServer,
  type Tier,
} from "./contract.js";
import { MUTATORS, Refusal, authorize, refuse, type PreCtx, type Tx } from "./mutators.js";
import {
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
import { DAY, deriveId, inWindow, isUlid, ulid } from "./ulid.js";

export const DEDUP_TTL = 7 * DAY;
export const TOMBSTONE_TTL = 30 * DAY;

const envelopeS = z.strictObject({
  mutationId: z.string(),
  name: z.string(),
  input: z.unknown(),
  protocolVersion: z.number().int(),
});
const cursorS = z.strictObject({ epoch: z.string(), version: z.number().int().nonnegative() });
const logS = z.string().regex(/^(space|user):[^:]+$/);

const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const fail = (e: Refusal): ApplyResult => ({ ok: false, error: e.toError() });
const same = (a: StoredRecord, b: StoredRecord) =>
  JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });

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
  readonly epochs = new Map<LogId, string>();
  /** The commit time of each version; version 0 is the store's start. */
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
    return this.epochs.get(log) ?? "e0";
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
    this.times[version] = now;
    for (const [key, next, prev] of writes) {
      if (next === null) {
        const old = prev as StoredRecord;
        this.records.delete(key);
        this.byKind.get(old.kind)?.delete(key);
        this.tombs.set(key, { rec: old, at: now });
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
        this.epochs.set(`space:${rec.id}`, `e${version}`);
    }
    return version;
  }

  prune(now: number) {
    for (const [key, t] of this.tombs) {
      if (t.at > now - TOMBSTONE_TTL) continue;
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
    if (!this.get(key) && idOf(r) !== null) return this.create(r);
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

export class ProtoServer implements TestServer {
  private readonly store: Store;
  private readonly dedup = new Map<string, { result: ApplyResult; at: number }>();
  private readonly last = new Map<string, string>();
  private readonly jobList: { kind: string; id: string }[] = [];
  private readonly clock: ServerOptions["clock"];
  private readonly random: () => number;

  constructor(options: ServerOptions) {
    this.clock = options.clock;
    this.random = options.random ?? Math.random;
    this.store = new Store(this.clock.now());
  }

  // ---- writes ----

  apply(actor: Actor | null, envelope: unknown): ApplyResult {
    const env = envelopeS.safeParse(envelope);
    if (!env.success)
      return fail(
        refuse("BAD_REQUEST", undefined, [
          "envelope: expected { mutationId, name, input, protocolVersion }",
        ]),
      );
    const m = env.data;
    if (m.protocolVersion < MIN_PROTOCOL_VERSION)
      return fail(
        refuse("PRECONDITION_FAILED", "Update Session.", [
          `protocolVersion: expected at least ${MIN_PROTOCOL_VERSION}`,
        ]),
      );
    if (!actor) return fail(refuse("UNAUTHORIZED"));
    const now = this.clock.now();
    this.prune(now);
    const dk = `${actor.u}\u0000${m.mutationId}`;
    const hit = this.dedup.get(dk);
    if (hit) return hit.result;
    const result = this.execute(actor.u, m, now);
    this.dedup.set(dk, { result, at: now });
    this.last.set(actor.u, m.mutationId);
    return result;
  }

  private execute(u: string, m: z.infer<typeof envelopeS>, now: number): ApplyResult {
    // DESIGN (phase 0 finding): mutation ids are ULIDs inside the same window
    // as record ids. Idempotency is kept 7 days; without a time in the
    // mutation id, a replay after 7 days would run again.
    if (!isUlid(m.mutationId))
      return fail(refuse("BAD_REQUEST", undefined, ["mutationId: expected a ULID"]));
    if (!inWindow(m.mutationId, now))
      return fail(
        refuse("BAD_REQUEST", undefined, ["mutationId: expected a ULID from the past 3 days"]),
      );
    const def = Object.hasOwn(MUTATORS, m.name) ? MUTATORS[m.name] : undefined;
    if (!def)
      return fail(refuse("NOT_FOUND", "The server has no procedure with this name.", ["name"]));
    const parsed = def.input.safeParse(m.input);
    if (!parsed.success)
      return fail(
        refuse(
          "BAD_REQUEST",
          undefined,
          parsed.error.issues.map(
            (x) => `input${x.path.map((p) => `.${String(p)}`).join("")}: ${x.code}`,
          ),
        ),
      );
    const input = parsed.data;
    for (const id of def.ids?.(input) ?? [])
      if (!inWindow(id, now))
        return fail(
          refuse("BAD_REQUEST", undefined, ["input.id: expected a ULID from the past 3 days"]),
        );
    const tx = new StagedTx(this.store, u, isoAt(now), m.mutationId);
    let result: unknown;
    try {
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
      result = def.run(tx, input, values);
    } catch (e) {
      if (e instanceof Refusal) return fail(e);
      throw e;
    }
    this.store.commit(tx.staged, now);
    if (def.post) this.post(def.post, input, result, now);
    return { ok: true, result };
  }

  /** Post-commit effects: server writes, in their own version. */
  private post(
    fn: NonNullable<(typeof MUTATORS)[string]["post"]>,
    input: unknown,
    result: unknown,
    now: number,
  ) {
    const staged = new Map<string, StoredRecord | null>();
    fn(
      {
        reader: this.store,
        notify: (n) => {
          const id = ulid(now, this.random);
          staged.set(`notif:${id}`, {
            ...n,
            kind: "notif",
            id,
            read: false,
            createdAt: isoAt(now),
            rev: 0,
          });
        },
        job: (kind, id) => this.jobList.push({ kind, id }),
      },
      input,
      result,
    );
    this.store.commit(staged, now);
  }

  private prune(now: number) {
    this.store.prune(now);
    for (const [k, d] of this.dedup) if (d.at <= now - DEDUP_TTL) this.dedup.delete(k);
  }

  // ---- reads ----

  private rows(log: LogId) {
    return this.store.logs.get(log) ?? new Map<string, LogRow>();
  }

  /** A user log is read by its user only; anyone else gets nothing from it. */
  private closedTo(log: LogId, u: string | null) {
    return log.startsWith("user:") && log !== `user:${u}`;
  }

  snapshot(actor: Actor | null, log: LogId, tier: Tier = "full"): Snapshot {
    const now = this.clock.now();
    this.prune(now);
    const u = actor?.u ?? null;
    const out: Snapshot = {
      records: [],
      version: this.store.head,
      epoch: this.store.epoch(log),
      lastMutationId: u === null ? null : (this.last.get(u) ?? null),
    };
    if (!logS.safeParse(log).success || this.closedTo(log, u)) return out;
    for (const row of this.rows(log).values()) {
      if (row.op !== "put") continue;
      const rec = this.store.get(row.key);
      if (!rec) continue;
      if (
        tier === "summary" &&
        (rec.kind === "followup" || rec.kind === "reply" || rec.kind === "run")
      )
        continue;
      const v = view(this.store, rec, u);
      if (v) out.records.push({ key: row.key, record: v });
    }
    return out;
  }

  pull(actor: Actor | null, log: LogId, cursor: Cursor): Pull {
    const now = this.clock.now();
    this.prune(now);
    const u = actor?.u ?? null;
    const c = cursorS.safeParse(cursor);
    if (!logS.safeParse(log).success || !c.success) return { resync: true };
    const { epoch, version } = c.data;
    if (epoch !== this.store.epoch(log) || version > this.store.head) return { resync: true };
    if ((this.store.times[version] ?? 0) < now - TOMBSTONE_TTL) return { resync: true };
    const lastMutationId = u === null ? null : (this.last.get(u) ?? null);
    const head = { version: this.store.head, epoch, lastMutationId };
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
        if (v) changes.push({ key: row.key, op: "put", record: v });
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
    return [...this.rows(log).values()].map((r) => ({ ...r }));
  }

  jobs() {
    return this.jobList;
  }
}

export const createProtoServer = (options: ServerOptions): TestServer => new ProtoServer(options);
