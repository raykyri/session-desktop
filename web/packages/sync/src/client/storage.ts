// Where a client keeps its replica and outbox between sessions. The client
// loads a log into its working set from here and writes each change back;
// queries read the working set only. Three adapters:
// - `MemoryStorage`: nothing outlives the process (the web client, which
//   holds a write only while its request is in flight, and tests);
// - `SqliteStorage`: over a `SqliteDriver`, an async interface the desktop
//   (Tauri's SQL plugin, phase 3) and the Phone implement; the tests run it
//   over Node's SQLite. Each write of the adapter (a log's change, the
//   outbox, the meta) is one call of the driver's `batch`, which runs its
//   statements in one transaction: a driver over a connection pool (Tauri's
//   plugin) cannot run BEGIN, the statements and COMMIT as separate calls,
//   since each may go to another connection. Reads are `select` calls.
// No adapter uses the DOM or Node: React Native runs them as the web does.

import type { LogId, StoredRecord } from "@session/mutators";

import type { Cursor } from "../protocol.js";

/** What a client keeps about itself. */
export interface ClientMeta {
  /** The person the replica and outbox belong to. */
  user: string;
  clientId: string | null;
  /** The last seq the server processed for `clientId`. */
  lastSeq: number;
  /** Milliseconds added to the device's clock, learned from CLOCK_SKEW. */
  offset: number;
  /** The threads the person opened (`hydrate`) in each space log, with when
   * (server time, as the client estimates it): reported in `tier.opened`
   * for 14 days. */
  opened?: Partial<Record<LogId, Record<string, number>>>;
}

/** One log as stored: its cursor, its records, and whether it is a frozen
 * copy (a closed space its user was removed from). */
export interface StoredLog {
  cursor: Cursor | null;
  frozen: boolean;
  records: [string, StoredRecord][];
}

/** One write to a stored log: puts and deletes, and the new cursor.
 * `replace` replaces every record (a snapshot or a resync). */
export interface LogChange {
  cursor: Cursor | null;
  frozen?: boolean;
  replace?: boolean;
  puts: [string, StoredRecord][];
  dels: string[];
}

export interface StorageAdapter {
  /** Whether what it stores outlives the process. */
  readonly persistent: boolean;
  loadMeta(): Promise<ClientMeta | null>;
  saveMeta(m: ClientMeta): Promise<void>;
  logs(): Promise<LogId[]>;
  loadLog(log: LogId): Promise<StoredLog | null>;
  saveLog(log: LogId, c: LogChange): Promise<void>;
  dropLog(log: LogId): Promise<void>;
  /** The outbox, in its one global order, as opaque JSON values. */
  loadOutbox(): Promise<unknown[]>;
  saveOutbox(entries: readonly unknown[]): Promise<void>;
  /** Forget everything (sign-out). */
  clear(): Promise<void>;
}

/** A copy of a JSON value (no structuredClone: React Native may lack it). */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class MemoryStorage implements StorageAdapter {
  readonly persistent = false;
  private meta: ClientMeta | null = null;
  private readonly stored = new Map<
    LogId,
    { cursor: Cursor | null; frozen: boolean; records: Map<string, StoredRecord> }
  >();
  private outbox: unknown[] = [];

  loadMeta = () => Promise.resolve(this.meta && copy(this.meta));
  saveMeta(m: ClientMeta) {
    this.meta = copy(m);
    return Promise.resolve();
  }
  logs = () => Promise.resolve([...this.stored.keys()]);
  loadLog(log: LogId) {
    const l = this.stored.get(log);
    return Promise.resolve(
      l ? { cursor: l.cursor, frozen: l.frozen, records: copy([...l.records]) } : null,
    );
  }
  saveLog(log: LogId, c: LogChange) {
    let l = this.stored.get(log);
    if (!l || c.replace)
      this.stored.set(log, (l = { cursor: null, frozen: false, records: new Map() }));
    l.cursor = c.cursor;
    if (c.frozen !== undefined) l.frozen = c.frozen;
    for (const [k, r] of c.puts) l.records.set(k, copy(r));
    for (const k of c.dels) l.records.delete(k);
    return Promise.resolve();
  }
  dropLog(log: LogId) {
    this.stored.delete(log);
    return Promise.resolve();
  }
  loadOutbox = () => Promise.resolve(copy(this.outbox));
  saveOutbox(entries: readonly unknown[]) {
    this.outbox = copy([...entries]);
    return Promise.resolve();
  }
  clear() {
    this.meta = null;
    this.stored.clear();
    this.outbox = [];
    return Promise.resolve();
  }
}

/** One SQL statement with its `?` parameters. */
export type SqlStatement = readonly [sql: string, params?: readonly unknown[]];

/** The SQLite a client storage needs: Tauri's SQL plugin's shape
 * (`execute`, `select`, both async), and `batch`. Statements use `?`
 * parameters. */
export interface SqliteDriver {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run the statements in order in one transaction on one connection:
   * every one applies, or (on an error, which it rejects with) none does.
   * Phase 3's Tauri driver provides it (a Rust command that runs them in a
   * transaction), since the plugin's `execute` may run each call on another
   * pooled connection. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

/** The client's tables, made when missing. */
export const CLIENT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sync_client_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sync_client_logs (log TEXT PRIMARY KEY, cursor TEXT, frozen INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sync_client_records (log TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (log, key))",
  "CREATE TABLE IF NOT EXISTS sync_client_outbox (pos INTEGER PRIMARY KEY, body TEXT NOT NULL)",
];

export class SqliteStorage implements StorageAdapter {
  readonly persistent = true;
  private ready: Promise<void> | null = null;
  /** Writes in order: each waits for the one before. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly db: SqliteDriver) {}

  private init(): Promise<void> {
    this.ready ??= this.db.batch(CLIENT_SCHEMA.map((sql) => [sql]));
    return this.ready;
  }

  /** One transaction: the statements, as one `batch` of the driver. */
  private write(statements: readonly SqlStatement[]): Promise<void> {
    const next = this.chain.then(async () => {
      await this.init();
      await this.db.batch(statements);
    });
    this.chain = next.catch(() => {});
    return next;
  }

  async loadMeta(): Promise<ClientMeta | null> {
    await this.init();
    const r = await this.db.select<{ v: string }>(
      "SELECT v FROM sync_client_meta WHERE k = 'meta'",
    );
    return r[0] ? (JSON.parse(r[0].v) as ClientMeta) : null;
  }
  saveMeta(m: ClientMeta) {
    return this.write([
      ["INSERT OR REPLACE INTO sync_client_meta (k, v) VALUES ('meta', ?)", [JSON.stringify(m)]],
    ]);
  }
  async logs(): Promise<LogId[]> {
    await this.init();
    return (await this.db.select<{ log: string }>("SELECT log FROM sync_client_logs")).map(
      (r) => r.log as LogId,
    );
  }
  async loadLog(log: LogId): Promise<StoredLog | null> {
    await this.init();
    const l = await this.db.select<{ cursor: string | null; frozen: number }>(
      "SELECT cursor, frozen FROM sync_client_logs WHERE log = ?",
      [log],
    );
    const head = l[0];
    if (!head) return null;
    const rows = await this.db.select<{ key: string; body: string }>(
      "SELECT key, body FROM sync_client_records WHERE log = ?",
      [log],
    );
    return {
      cursor: head.cursor,
      frozen: Number(head.frozen) === 1,
      records: rows.map((r) => [r.key, JSON.parse(r.body) as StoredRecord]),
    };
  }
  saveLog(log: LogId, c: LogChange) {
    // a change that does not say whether the log is frozen keeps what is
    // stored (no read inside the transaction: a batch has none)
    const frozen = c.frozen === undefined ? null : c.frozen ? 1 : 0;
    return this.write([
      ...(c.replace
        ? [["DELETE FROM sync_client_records WHERE log = ?", [log]] as const]
        : []),
      [
        "INSERT INTO sync_client_logs (log, cursor, frozen) VALUES (?, ?, COALESCE(?, 0)) " +
          "ON CONFLICT (log) DO UPDATE SET cursor = excluded.cursor, " +
          "frozen = COALESCE(?, sync_client_logs.frozen)",
        [log, c.cursor, frozen, frozen],
      ],
      ...c.puts.map(
        ([k, r]) =>
          [
            "INSERT OR REPLACE INTO sync_client_records (log, key, body) VALUES (?, ?, ?)",
            [log, k, JSON.stringify(r)],
          ] as const,
      ),
      ...c.dels.map(
        (k) => ["DELETE FROM sync_client_records WHERE log = ? AND key = ?", [log, k]] as const,
      ),
    ]);
  }
  dropLog(log: LogId) {
    return this.write([
      ["DELETE FROM sync_client_records WHERE log = ?", [log]],
      ["DELETE FROM sync_client_logs WHERE log = ?", [log]],
    ]);
  }
  async loadOutbox(): Promise<unknown[]> {
    await this.init();
    return (
      await this.db.select<{ body: string }>("SELECT body FROM sync_client_outbox ORDER BY pos")
    ).map((r) => JSON.parse(r.body) as unknown);
  }
  saveOutbox(entries: readonly unknown[]) {
    return this.write([
      ["DELETE FROM sync_client_outbox"],
      ...[...entries.entries()].map(
        ([k, e]) =>
          ["INSERT INTO sync_client_outbox (pos, body) VALUES (?, ?)", [k, JSON.stringify(e)]] as const,
      ),
    ]);
  }
  clear() {
    return this.write(
      ["sync_client_meta", "sync_client_logs", "sync_client_records", "sync_client_outbox"].map(
        (t) => [`DELETE FROM ${t}`] as const,
      ),
    );
  }
}
