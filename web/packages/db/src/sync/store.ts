// `SqliteStore`: the `ServerStore` of `@session/sync/server` over the
// database (`15-implementation-plan/01-architecture-and-data.md` D1-D3, M3).
// Every method is one or two prepared statements on the better-sqlite3
// connection and runs synchronously, so a mutator's stages, the permission
// checks and the commit run in one `db.transaction()` with no `await` between
// them (`01` §1). `transaction` nests as a savepoint.
//
// `putRecord` and `deleteRecord` are the only code that writes `records`
// (a test greps this directory for it, `01` D1). A record's body is its JSON
// as the mutator wrote it, validated with the shared contract's schema when
// written and when first read, and returned as parsed, so a record read back
// compares equal (key order included) with the one written.
//
// Reads are cached by key, because the server reads the same records many
// times in one write and in one snapshot. The cache holds only committed or
// in-transaction values written through this store, and is dropped whole when
// a transaction rolls back.

import {
  indexOf,
  isClosed,
  uniqueOf,
  type Index,
  type Kind,
  type LogId,
  type StoredRecord,
  type UniqueIndex,
} from "@session/mutators";
import { spaces } from "@session/shared";
import type {
  AccountStatus,
  AnswerRow,
  ClientRow,
  Epoch,
  LogRow,
  SeqAnswerRow,
  ServerStore,
  Tombstone,
} from "@session/sync/server";
import type SqliteDatabase from "better-sqlite3";
import { z } from "zod";

import type { SessionDatabase } from "../connection.js";

/** The prototype's join request (`01` C10): kept in the union so the
 * acceptance suite's join-request mutators run on this store, and not in the
 * contract's `storedRecordSchema`. */
const requestRecordSchema = z.strictObject({
  kind: z.literal("request"),
  sp: z.string(),
  u: z.string(),
  st: z.enum(["open", "approved", "declined"]),
  why: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  rev: z.number().int(),
});

/** Why a record failed its schema, or null when it is valid. */
export function invalidRecord(r: unknown): string | null {
  const kind = (r as { kind?: unknown } | null)?.kind;
  const p =
    kind === "request" ? requestRecordSchema.safeParse(r) : spaces.storedRecordSchema.safeParse(r);
  if (p.success) return null;
  const x = p.error.issues[0];
  return `${String(kind)}: ${x ? `${x.path.join(".")} ${x.message}` : "invalid"}`;
}

/** A record that failed its schema on its way in or out of the store: a
 * mutator bug, or a stored shape a backfill has not rewritten (`01` D7). */
export class InvalidRecordError extends Error {
  constructor(key: string, why: string) {
    super(`record ${key} does not match its schema: ${why}`);
    this.name = "InvalidRecordError";
  }
}

/** How many parsed records the read cache keeps by default: enough for the
 * records one write or one window snapshot reads again, and few enough that
 * the cache is full, and the process's memory flat, within minutes of load
 * (`runbooks/load-check.md`). */
export const RECORD_CACHE_SIZE = 5_000;

/** The kinds a unique lookup reads. */
const UNIQUE: readonly [UniqueIndex, Kind][] = [
  ["space.name", "space"],
  ["invite.code", "invite"],
];

const KIND_OF_UNIQUE: Readonly<Record<UniqueIndex, Kind>> = {
  "space.name": "space",
  "invite.code": "invite",
};

interface RecordRow {
  body: string;
}

export interface SqliteStoreOptions {
  /** The time `updated_at` and `server_meta` rows are written with (ms).
   * The sync server passes its own times to every method that stores a
   * time the protocol reads; this one is for the columns nothing reads. */
  now?: () => number;
  /** Called after each outermost transaction commits, with the logs whose
   * rows or history it wrote: the server wakes the event streams that read
   * them (`01` Y7). Not called for a transaction that rolled back. */
  onCommit?: (logs: ReadonlySet<LogId>) => void;
  /** How many parsed records the read cache keeps (`RECORD_CACHE_SIZE`). */
  cacheSize?: number;
}

export class SqliteStore implements ServerStore {
  readonly sqlite: SqliteDatabase.Database;
  private readonly now: () => number;
  private readonly cache = new Map<string, StoredRecord | null>();
  private readonly s;
  private readonly onCommit: ((logs: ReadonlySet<LogId>) => void) | undefined;
  private readonly cacheSize: number;
  /** The logs the open transaction wrote. */
  private touched = new Set<LogId>();

  constructor(db: SessionDatabase | SqliteDatabase.Database, options: SqliteStoreOptions = {}) {
    this.sqlite = "$client" in db ? db.$client : db;
    this.now = options.now ?? Date.now;
    this.onCommit = options.onCommit;
    this.cacheSize = options.cacheSize ?? RECORD_CACHE_SIZE;
    const c = this.sqlite;
    this.s = {
      byKey: c.prepare<[string], RecordRow>("SELECT body FROM records WHERE key = ?"),
      keysBySp: c.prepare<[string, string], { key: string }>(
        "SELECT key FROM records WHERE kind = ? AND sp = ?",
      ),
      keysByTh: c.prepare<[string, string], { key: string }>(
        "SELECT key FROM records WHERE kind = ? AND th = ?",
      ),
      keysByU: c.prepare<[string, string], { key: string }>(
        "SELECT key FROM records WHERE kind = ? AND u = ?",
      ),
      uniqueKey: c.prepare<[string, string], { key: string }>(
        "SELECT key FROM records WHERE kind = ? AND uniq = ?",
      ),
      insertRecord: c.prepare(
        `INSERT INTO records (key, kind, sp, th, u, uniq, body, rev, created_v, created_at, updated_at)
         VALUES (@key, @kind, @sp, @th, @u, @uniq, @body, @rev, @createdV, @createdAt, @updatedAt)
         ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, sp = excluded.sp, th = excluded.th,
           u = excluded.u, uniq = excluded.uniq, body = excluded.body, rev = excluded.rev,
           created_v = excluded.created_v, created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      ),
      updateRecord: c.prepare(
        `UPDATE records SET kind = @kind, sp = @sp, th = @th, u = @u, uniq = @uniq, body = @body,
           rev = @rev, updated_at = @updatedAt WHERE key = @key`,
      ),
      deleteRecord: c.prepare<[string]>("DELETE FROM records WHERE key = ?"),
      createdVersion: c.prepare<[string], { v: number }>(
        "SELECT created_v AS v FROM records WHERE key = ?",
      ),
      keysCreatedBefore: c.prepare<[string, number], { key: string }>(
        "SELECT key FROM records WHERE kind = ? AND created_at < ? ORDER BY created_v",
      ),
      registryHas: c.prepare<[string], { r: number }>(
        "SELECT last_rev AS r FROM registry WHERE name = ?",
      ),
      setLastRev: c.prepare<[string, number]>(
        "INSERT INTO registry (name, last_rev) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_rev = excluded.last_rev",
      ),
      tombstone: c.prepare<
        [string],
        {
          key: string;
          kind: string;
          sp: string | null;
          person: string | null;
          by_u: string | null;
          deleted_at: number;
        }
      >("SELECT * FROM tombstones WHERE key = ?"),
      putTombstone: c.prepare(
        `INSERT INTO tombstones (key, kind, sp, person, by_u, deleted_at)
         VALUES (@key, @kind, @sp, @person, @by, @at)
         ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, sp = excluded.sp,
           person = excluded.person, by_u = excluded.by_u, deleted_at = excluded.deleted_at`,
      ),
      deleteTombstone: c.prepare<[string]>("DELETE FROM tombstones WHERE key = ?"),
      pruneDelRows: c.prepare<[number]>(
        `DELETE FROM change_log WHERE op = 'del'
           AND key IN (SELECT key FROM tombstones WHERE deleted_at < ?)`,
      ),
      pruneTombstones: c.prepare<[number]>("DELETE FROM tombstones WHERE deleted_at < ?"),
      head: c.prepare<[], { version: number }>("SELECT version FROM server_head WHERE id = 1"),
      nextVersion: c.prepare<[], { version: number }>(
        "UPDATE server_head SET version = version + 1 WHERE id = 1 RETURNING version",
      ),
      seedHead: c.prepare("INSERT OR IGNORE INTO server_head (id, version) VALUES (1, 0)"),
      // a write moves the key's row to the end of its version's rows (a new
      // rowid), so rows of one commit read back in the order they were written
      dropLogRow: c.prepare<[string, string]>("DELETE FROM change_log WHERE log = ? AND key = ?"),
      putLogRow: c.prepare<[string, string, string, number]>(
        "INSERT INTO change_log (log, key, op, version) VALUES (?, ?, ?, ?)",
      ),
      logRow: c.prepare<[string, string], LogRow>(
        "SELECT key, op, version FROM change_log WHERE log = ? AND key = ?",
      ),
      logRows: c.prepare<[string, number], LogRow>(
        "SELECT key, op, version FROM change_log WHERE log = ? AND version > ? ORDER BY version, rowid",
      ),
      epoch: c.prepare<[string], { n: number; start: number }>(
        "SELECT epoch AS n, start_version AS start FROM log_epochs WHERE log = ?",
      ),
      setEpoch: c.prepare<[string, number, number]>(
        `INSERT INTO log_epochs (log, epoch, start_version) VALUES (?, ?, ?)
         ON CONFLICT (log) DO UPDATE SET epoch = excluded.epoch, start_version = excluded.start_version`,
      ),
      client: c.prepare<
        [string],
        { client_id: string; u: string; last_seq: number; created_at: number; last_used_at: number }
      >("SELECT * FROM sync_clients WHERE client_id = ?"),
      putClient: c.prepare(
        `INSERT INTO sync_clients (client_id, u, last_seq, created_at, last_used_at)
         VALUES (@clientId, @u, @last, @createdAt, @seen)
         ON CONFLICT (client_id) DO UPDATE SET u = excluded.u, last_seq = excluded.last_seq,
           last_used_at = excluded.last_used_at`,
      ),
      registrationsSince: c.prepare<[string, number], { n: number }>(
        "SELECT count(*) AS n FROM sync_clients WHERE u = ? AND created_at >= ?",
      ),
      pruneClients: c.prepare<[number]>("DELETE FROM sync_clients WHERE last_used_at <= ?"),
      answer: c.prepare<[string, string], { digest: string; result_json: string; at: number }>(
        "SELECT digest, result_json, at FROM sync_answers WHERE u = ? AND mutation_id = ?",
      ),
      putAnswer: c.prepare<[string, string, string, string, number]>(
        `INSERT INTO sync_answers (u, mutation_id, digest, result_json, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (u, mutation_id) DO UPDATE SET digest = excluded.digest,
           result_json = excluded.result_json, at = excluded.at`,
      ),
      seqAnswer: c.prepare<[string, number], { digest: string; result_json: string; at: number }>(
        "SELECT digest, result_json, at FROM sync_seq_answers WHERE client_id = ? AND seq = ?",
      ),
      putSeqAnswer: c.prepare<[string, number, string, string, number]>(
        `INSERT INTO sync_seq_answers (client_id, seq, digest, result_json, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (client_id, seq) DO UPDATE SET digest = excluded.digest,
           result_json = excluded.result_json, at = excluded.at`,
      ),
      pruneAnswers: c.prepare<[number]>("DELETE FROM sync_answers WHERE at <= ?"),
      pruneSeqAnswers: c.prepare<[number]>("DELETE FROM sync_seq_answers WHERE at <= ?"),
      account: c.prepare<[string], { status: AccountStatus }>(
        "SELECT status FROM users WHERE handle = ? AND deleted_at IS NULL",
      ),
      saveCount: c.prepare<[string], { saves: number }>(
        "SELECT saves FROM save_counts WHERE th = ?",
      ),
      bumpSaves: c.prepare<[{ th: string; d: number }]>(
        `INSERT INTO save_counts (th, saves) VALUES (@th, max(@d, 0))
         ON CONFLICT (th) DO UPDATE SET saves = max(saves + @d, 0)`,
      ),
      dropSaves: c.prepare<[string]>("DELETE FROM save_counts WHERE th = ? AND saves <= 0"),
    };
    if (!this.sqlite.readonly && !this.s.head.get()) this.s.seedHead.run();
  }

  transaction<T>(fn: () => T): T {
    const outer = !this.sqlite.inTransaction;
    let out: T;
    try {
      // nested: better-sqlite3 runs it in a savepoint, rolled back to on a
      // throw before the exception reaches the caller
      out = this.sqlite.transaction(fn)();
    } catch (e) {
      // the rows went back; so do the parsed copies of what was written
      this.cache.clear();
      if (outer) this.touched = new Set();
      throw e;
    }
    if (outer && this.touched.size) {
      const logs = this.touched;
      this.touched = new Set();
      this.onCommit?.(logs);
    }
    return out;
  }

  // ---- Source ----

  byKey(key: string): StoredRecord | undefined {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const row = this.s.byKey.get(key);
    const rec = row ? (JSON.parse(row.body) as StoredRecord) : null;
    if (rec) {
      const why = invalidRecord(rec);
      if (why !== null) throw new InvalidRecordError(key, why);
    }
    this.remember(key, rec);
    return rec ?? undefined;
  }

  private remember(key: string, rec: StoredRecord | null) {
    if (this.cache.size >= this.cacheSize) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, rec);
  }

  keysIn(kind: Kind, index: Index): Iterable<string> {
    const rows =
      "sp" in index
        ? this.s.keysBySp.all(kind, index.sp)
        : "th" in index
          ? this.s.keysByTh.all(kind, index.th)
          : this.s.keysByU.all(kind, index.u);
    return rows.map((r) => r.key);
  }

  uniqueKey(index: UniqueIndex, value: string): string | undefined {
    return this.s.uniqueKey.get(KIND_OF_UNIQUE[index], value)?.key;
  }

  idTaken(id: string): boolean {
    return this.s.registryHas.get(id) !== undefined;
  }

  lastRev(name: string): number | undefined {
    return this.s.registryHas.get(name)?.r;
  }

  // ---- records ----

  /** The columns of a record's row (`01` D1). */
  private row(key: string, r: StoredRecord) {
    const why = invalidRecord(r);
    if (why !== null) throw new InvalidRecordError(key, why);
    const cols = indexOf(r);
    let uniq: string | null = null;
    for (const [u, kind] of UNIQUE) if (r.kind === kind) uniq = uniqueOf(r, u);
    return {
      key,
      kind: r.kind,
      sp: cols.sp,
      th: cols.th,
      u: cols.u,
      uniq,
      body: JSON.stringify(r),
      rev: r.rev,
      updatedAt: this.now(),
    };
  }

  putRecord(
    key: string,
    record: StoredRecord,
    created: { version: number; at: number } | null,
  ): void {
    const row = this.row(key, record);
    const existed = this.s.createdVersion.get(key) !== undefined;
    if (created)
      this.s.insertRecord.run({ ...row, createdV: created.version, createdAt: created.at });
    else if (existed) this.s.updateRecord.run(row);
    else this.s.insertRecord.run({ ...row, createdV: 0, createdAt: 0 });
    if (record.kind === "save" && !existed) this.countSave(record.th, 1);
    this.remember(key, record);
  }

  deleteRecord(key: string): void {
    const prev = this.byKey(key);
    if (!prev) return;
    this.s.deleteRecord.run(key);
    if (prev.kind === "save") this.countSave(prev.th, -1);
    this.remember(key, null);
  }

  /** `save_counts` (`01` C1, D3): the true save count of a thread in a
   * private channel, kept beside the served count of its counts record. */
  private countSave(th: string, delta: 1 | -1) {
    const t = this.byKey(`thread:${th}`);
    const s = t?.kind === "thread" ? this.byKey(`space:${t.s}`) : undefined;
    if (s?.kind === "space" && !isClosed(s)) return;
    this.s.bumpSaves.run({ th, d: delta });
    if (delta < 0) this.s.dropSaves.run(th);
  }

  /** The true save count of a private channel's thread (`save_counts`). */
  trueSaves(th: string): number {
    return this.s.saveCount.get(th)?.saves ?? 0;
  }

  createdVersion(key: string): number | undefined {
    return this.s.createdVersion.get(key)?.v;
  }

  keysCreatedBefore(kind: Kind, at: number): string[] {
    return this.s.keysCreatedBefore.all(kind, at).map((r) => r.key);
  }

  setLastRev(name: string, rev: number): void {
    this.s.setLastRev.run(name, rev);
  }

  // ---- tombstones ----

  tombstone(key: string): Tombstone | undefined {
    const t = this.s.tombstone.get(key);
    return t
      ? {
          key: t.key,
          kind: t.kind as Kind,
          sp: t.sp,
          person: t.person,
          by: t.by_u,
          at: t.deleted_at,
        }
      : undefined;
  }

  putTombstone(t: Tombstone): void {
    this.s.putTombstone.run({
      key: t.key,
      kind: t.kind,
      sp: t.sp,
      person: t.person,
      by: t.by,
      at: t.at,
    });
  }

  deleteTombstone(key: string): void {
    this.s.deleteTombstone.run(key);
  }

  pruneTombstones(at: number): void {
    this.s.pruneDelRows.run(at);
    this.s.pruneTombstones.run(at);
  }

  // ---- change log ----

  head(): number {
    return this.s.head.get()?.version ?? 0;
  }

  nextVersion(): number {
    const v = this.s.nextVersion.get();
    if (!v) throw new Error("server_head has no row");
    return v.version;
  }

  putLogRow(log: LogId, row: LogRow): void {
    this.s.dropLogRow.run(log, row.key);
    this.s.putLogRow.run(log, row.key, row.op, row.version);
    this.touched.add(log);
  }

  logRow(log: LogId, key: string): LogRow | undefined {
    return this.s.logRow.get(log, key);
  }

  logRows(log: LogId, after: number): LogRow[] {
    return this.s.logRows.all(log, after);
  }

  epoch(log: LogId): Epoch {
    return this.s.epoch.get(log) ?? { n: 0, start: 0 };
  }

  setEpoch(log: LogId, epoch: Epoch): void {
    this.s.setEpoch.run(log, epoch.n, epoch.start);
    this.touched.add(log);
  }

  // ---- clients ----

  client(clientId: string): ClientRow | undefined {
    const c = this.s.client.get(clientId);
    return c
      ? {
          clientId: c.client_id,
          u: c.u,
          last: c.last_seq,
          createdAt: c.created_at,
          seen: c.last_used_at,
        }
      : undefined;
  }

  putClient(row: ClientRow): void {
    this.s.putClient.run({ ...row });
  }

  registrationsSince(u: string, at: number): number {
    return this.s.registrationsSince.get(u, at)?.n ?? 0;
  }

  pruneClients(at: number): void {
    this.s.pruneClients.run(at);
  }

  /** Registrations are counted from `sync_clients.created_at`, and a client
   * lives longer than the day they are counted over: nothing to forget. */
  pruneRegistrations(): void {}

  // ---- recorded answers ----

  answer(u: string, mutationId: string): AnswerRow | undefined {
    const a = this.s.answer.get(u, mutationId);
    return a
      ? {
          u,
          mutationId,
          digest: a.digest,
          result: JSON.parse(a.result_json) as AnswerRow["result"],
          at: a.at,
        }
      : undefined;
  }

  putAnswer(row: AnswerRow): void {
    this.s.putAnswer.run(row.u, row.mutationId, row.digest, JSON.stringify(row.result), row.at);
  }

  seqAnswer(clientId: string, seq: number): SeqAnswerRow | undefined {
    const a = this.s.seqAnswer.get(clientId, seq);
    return a
      ? {
          clientId,
          seq,
          digest: a.digest,
          result: JSON.parse(a.result_json) as SeqAnswerRow["result"],
          at: a.at,
        }
      : undefined;
  }

  putSeqAnswer(row: SeqAnswerRow): void {
    this.s.putSeqAnswer.run(row.clientId, row.seq, row.digest, JSON.stringify(row.result), row.at);
  }

  pruneAnswers(at: number): void {
    this.s.pruneAnswers.run(at);
    this.s.pruneSeqAnswers.run(at);
  }

  // ---- accounts ----

  isAccount(handle: string): boolean {
    return this.s.account.get(handle) !== undefined;
  }

  accountStatus(handle: string): AccountStatus | null {
    return this.s.account.get(handle)?.status ?? null;
  }
}
