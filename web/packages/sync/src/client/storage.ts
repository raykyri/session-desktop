// Where a client keeps its replica and outbox between sessions. The client
// loads a log into its working set from here and writes each change back;
// queries read the working set only. Three adapters:
// - `MemoryStorage`: nothing outlives the process (the web client, which
//   holds a write only while its request is in flight, and tests);
// - `SqliteStorage`: over a `SqliteDriver`, an async interface the desktop
//   (the app's replica commands, phase 3) and the Phone implement; the
//   tests run it over Node's SQLite. Each write of the adapter (a log's
//   change, the outbox, the meta) is one call of the driver's `batch`,
//   which runs its statements in one transaction: the desktop's commands
//   refuse BEGIN and COMMIT from the page, so a transaction is never split
//   over calls. Reads are `select` calls.
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
  /** Stop using it: a write still waiting, and every later call, is
   * refused (`StorageClosed`); resolves once a write in progress ended. */
  close?(): Promise<void>;
}

/** A call on a closed storage. */
export class StorageClosed extends Error {
  constructor() {
    super("The storage is closed.");
    this.name = "StorageClosed";
  }
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

/** The SQLite a client storage needs (`execute`, `select`, both async, and
 * `batch`). Statements use `?` parameters; one statement a call. */
export interface SqliteDriver {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run the statements in order in one transaction on one connection:
   * every one applies, or (on an error, which it rejects with) none does
   * (the desktop: the app's `replica_batch` command). */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

/** The version of the client's tables (`PRAGMA user_version`); a change of
 * `CLIENT_SCHEMA` raises it. */
export const CLIENT_SCHEMA_VERSION = 1;

/** The client's tables, made when missing. */
export const CLIENT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sync_client_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sync_client_logs (log TEXT PRIMARY KEY, cursor TEXT, frozen INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sync_client_records (log TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (log, key))",
  "CREATE TABLE IF NOT EXISTS sync_client_outbox (pos INTEGER PRIMARY KEY, body TEXT NOT NULL)",
];

const CLIENT_TABLES = [
  "sync_client_meta",
  "sync_client_logs",
  "sync_client_records",
  "sync_client_outbox",
] as const;

/** The client's tables over a `SqliteDriver`, in a file whose
 * `user_version` is `CLIENT_SCHEMA_VERSION` (review round 1 of phase 3,
 * finding 13). A file of another version, or of none (made before the
 * version existed), is made again in one transaction: the replica's logs
 * are dropped and read again from the server, and the meta (the client id
 * and its seq) and the outbox are kept, as their text; a new file gets the
 * tables. A failure to open the tables is not kept: the next call tries
 * again (finding 7). */
export class SqliteStorage implements StorageAdapter {
  readonly persistent = true;
  private ready: Promise<void> | null = null;
  /** Writes in order: each waits for the one before. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly db: SqliteDriver) {}

  private init(): Promise<void> {
    if (this.closed) return Promise.reject(new StorageClosed());
    this.ready ??= this.setup().catch((e: unknown) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  /** The tables at this version: made, or made again keeping the meta and
   * the outbox. */
  private async setup(): Promise<void> {
    const v = await this.db.select<{ user_version: number }>("PRAGMA user_version");
    const version = Number(v[0]?.user_version ?? 0);
    if (version === CLIENT_SCHEMA_VERSION) return;
    const kept = await this.keptRows();
    await this.db.batch([
      ...CLIENT_TABLES.map((t) => [`DROP TABLE IF EXISTS ${t}`] as const),
      ...CLIENT_SCHEMA.map((sql) => [sql] as const),
      ...(kept.meta === null
        ? []
        : [["INSERT INTO sync_client_meta (k, v) VALUES ('meta', ?)", [kept.meta]] as const]),
      ...kept.outbox.map(
        (body, k) =>
          ["INSERT INTO sync_client_outbox (pos, body) VALUES (?, ?)", [k, body]] as const,
      ),
      [`PRAGMA user_version = ${CLIENT_SCHEMA_VERSION}`],
    ]);
  }

  /** The meta and the outbox of a file made at another version, as their
   * stored text (none when the file has no such tables). */
  private async keptRows(): Promise<{ meta: string | null; outbox: string[] }> {
    const tables = new Set(
      (
        await this.db.select<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
      ).map((r) => r.name),
    );
    const meta = tables.has("sync_client_meta")
      ? ((await this.db.select<{ v: string }>("SELECT v FROM sync_client_meta WHERE k = 'meta'"))[0]
          ?.v ?? null)
      : null;
    const outbox = tables.has("sync_client_outbox")
      ? (
          await this.db.select<{ body: string }>("SELECT body FROM sync_client_outbox ORDER BY pos")
        ).map((r) => r.body)
      : [];
    return { meta, outbox };
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

  /** Stop using the file: a write still waiting, and every later call,
   * is refused; resolves once a write in progress ended (sign-out:
   * nothing a late answer brings is stored after it; finding 1). */
  close(): Promise<void> {
    this.closed = true;
    return this.chain;
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
      ...(c.replace ? [["DELETE FROM sync_client_records WHERE log = ?", [log]] as const] : []),
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
          [
            "INSERT INTO sync_client_outbox (pos, body) VALUES (?, ?)",
            [k, JSON.stringify(e)],
          ] as const,
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
