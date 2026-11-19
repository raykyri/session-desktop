// Where a client keeps its replica and outbox between sessions. The client
// loads a log into its working set from here and writes each change back;
// queries read the working set only. Three adapters:
// - `MemoryStorage`: nothing outlives the process (the web client, which
//   holds a write only while its request is in flight, and tests);
// - `SqliteStorage`: over a `SqliteDriver`, an async interface the desktop
//   (Tauri's SQL plugin, phase 3) and the Phone implement; the tests run it
//   over Node's SQLite.
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

/** The SQLite a client storage needs: Tauri's SQL plugin's shape
 * (`execute`, `select`, both async). Statements use `?` parameters. */
export interface SqliteDriver {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
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
    this.ready ??= (async () => {
      for (const sql of CLIENT_SCHEMA) await this.db.execute(sql);
    })();
    return this.ready;
  }

  private write(f: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      await this.init();
      await this.db.execute("BEGIN");
      try {
        await f();
        await this.db.execute("COMMIT");
      } catch (e) {
        await this.db.execute("ROLLBACK");
        throw e;
      }
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
    return this.write(() =>
      this.db.execute("INSERT OR REPLACE INTO sync_client_meta (k, v) VALUES ('meta', ?)", [
        JSON.stringify(m),
      ]),
    );
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
    return this.write(async () => {
      if (c.replace) await this.db.execute("DELETE FROM sync_client_records WHERE log = ?", [log]);
      const old = await this.db.select<{ frozen: number }>(
        "SELECT frozen FROM sync_client_logs WHERE log = ?",
        [log],
      );
      const frozen = c.frozen ?? (old[0] ? Number(old[0].frozen) === 1 : false);
      await this.db.execute(
        "INSERT OR REPLACE INTO sync_client_logs (log, cursor, frozen) VALUES (?, ?, ?)",
        [log, c.cursor, frozen ? 1 : 0],
      );
      for (const [k, r] of c.puts)
        await this.db.execute(
          "INSERT OR REPLACE INTO sync_client_records (log, key, body) VALUES (?, ?, ?)",
          [log, k, JSON.stringify(r)],
        );
      for (const k of c.dels)
        await this.db.execute("DELETE FROM sync_client_records WHERE log = ? AND key = ?", [
          log,
          k,
        ]);
    });
  }
  dropLog(log: LogId) {
    return this.write(async () => {
      await this.db.execute("DELETE FROM sync_client_records WHERE log = ?", [log]);
      await this.db.execute("DELETE FROM sync_client_logs WHERE log = ?", [log]);
    });
  }
  async loadOutbox(): Promise<unknown[]> {
    await this.init();
    return (
      await this.db.select<{ body: string }>("SELECT body FROM sync_client_outbox ORDER BY pos")
    ).map((r) => JSON.parse(r.body) as unknown);
  }
  saveOutbox(entries: readonly unknown[]) {
    return this.write(async () => {
      await this.db.execute("DELETE FROM sync_client_outbox");
      for (const [k, e] of entries.entries())
        await this.db.execute("INSERT INTO sync_client_outbox (pos, body) VALUES (?, ?)", [
          k,
          JSON.stringify(e),
        ]);
    });
  }
  clear() {
    return this.write(async () => {
      for (const t of [
        "sync_client_meta",
        "sync_client_logs",
        "sync_client_records",
        "sync_client_outbox",
      ])
        await this.db.execute(`DELETE FROM ${t}`);
    });
  }
}
