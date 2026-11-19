// `ServerStore` over SQLite. The package takes the database as a small
// interface, which better-sqlite3 (what `web/packages/db` uses) satisfies, so
// it depends on no driver. The schema is the plain SQL in `migrations/`,
// applied in order by `migrate` and recorded in `sync_migrations`.

import { readdirSync, readFileSync } from "node:fs";

import { INDEXES, type Effect, type LogId, type StoredRecord } from "@session/mutators";

import type {
  ClientRec,
  DeadLetter,
  DeviceToken,
  Epoch,
  Lease,
  LogRow,
  QueuedEffect,
  ServerStore,
  Signin,
  StoreDump,
  StoreTx,
  StoredAnswer,
  Tombstone,
} from "./store.js";

/** The part of a better-sqlite3 database the store uses. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** Apply the package's migrations that `db` has not had, in name order. */
export function migrate(db: SqliteDatabase): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sync_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  );
  const done = new Set(
    (db.prepare("SELECT name FROM sync_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (done.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
      db.prepare("INSERT INTO sync_migrations (name, at) VALUES (?, ?)").run(name, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    applied.push(name);
  }
  return applied;
}

const INDEXED = new Map<string, string[]>();
for (const [kind, field] of Object.values(INDEXES)) {
  const l = INDEXED.get(kind) ?? [];
  if (!l.includes(field)) l.push(field);
  INDEXED.set(kind, l);
}

type Row = Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: unknown) => JSON.parse(String(s)) as T;
const num = (v: unknown) => Number(v);

function tombOf(r: Row): Tombstone {
  const t: Tombstone = {
    key: String(r["key"]),
    kind: r["kind"] as Tombstone["kind"],
    sp: (r["sp"] as string | null) ?? null,
    person: (r["person"] as string | null) ?? null,
    by: (r["who"] as string | null) ?? null,
    at: num(r["at"]),
  };
  if (r["type"] !== null && r["type"] !== undefined)
    t.type = r["type"] as NonNullable<Tombstone["type"]>;
  return t;
}

class SqliteTx implements StoreTx {
  constructor(private readonly s: (sql: string) => SqliteStatement) {}

  private metaGet(k: string) {
    const r = this.s("SELECT v FROM sync_meta WHERE k = ?").get(k) as Row | undefined;
    return r ? num(r["v"]) : 0;
  }
  private metaSet(k: string, v: number) {
    this.s(
      "INSERT INTO sync_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
    ).run(k, v);
  }
  head = () => this.metaGet("head");
  setHead = (v: number) => this.metaSet("head", v);
  lastTime = () => this.metaGet("lastTime");
  setLastTime = (v: number) => this.metaSet("lastTime", v);

  get(key: string) {
    const r = this.s("SELECT body FROM sync_records WHERE key = ?").get(key) as Row | undefined;
    return r ? parse<StoredRecord>(r["body"]) : undefined;
  }
  scan(kind: string, field: string, value: string) {
    return (
      this.s(
        "SELECT r.body FROM sync_index i JOIN sync_records r ON r.key = i.key WHERE i.kind = ? AND i.field = ? AND i.value = ? ORDER BY i.key",
      ).all(kind, field, value) as Row[]
    ).map((r) => parse<StoredRecord>(r["body"]));
  }
  put(key: string, record: StoredRecord, born: number) {
    this.s(
      "INSERT INTO sync_records (key, kind, body, born) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body",
    ).run(key, record.kind, json(record), born);
    this.s("DELETE FROM sync_index WHERE key = ?").run(key);
    for (const f of INDEXED.get(record.kind) ?? []) {
      const v = (record as unknown as Row)[f];
      if (typeof v === "string")
        this.s("INSERT INTO sync_index (kind, field, value, key) VALUES (?, ?, ?, ?)").run(
          record.kind,
          f,
          v,
          key,
        );
    }
  }
  del(key: string) {
    this.s("DELETE FROM sync_records WHERE key = ?").run(key);
    this.s("DELETE FROM sync_index WHERE key = ?").run(key);
  }
  born(key: string) {
    const r = this.s("SELECT born FROM sync_records WHERE key = ?").get(key) as Row | undefined;
    return r ? num(r["born"]) : undefined;
  }

  registryGet(id: string) {
    const r = this.s("SELECT rev FROM sync_registry WHERE id = ?").get(id) as Row | undefined;
    return r ? num(r["rev"]) : undefined;
  }
  registrySet(id: string, rev: number) {
    this.s(
      "INSERT INTO sync_registry (id, rev) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET rev = excluded.rev",
    ).run(id, rev);
  }

  logPut(log: LogId, row: LogRow) {
    const ord = this.metaGet("logOrd") + 1;
    this.metaSet("logOrd", ord);
    this.s(
      "INSERT INTO sync_log (log, key, op, version, ord) VALUES (?, ?, ?, ?, ?) ON CONFLICT (log, key) DO UPDATE SET op = excluded.op, version = excluded.version, ord = excluded.ord",
    ).run(log, row.key, row.op, row.version, ord);
  }
  logDelete(log: LogId, key: string) {
    this.s("DELETE FROM sync_log WHERE log = ? AND key = ?").run(log, key);
  }
  logGet(log: LogId, key: string) {
    const r = this.s("SELECT key, op, version FROM sync_log WHERE log = ? AND key = ?").get(
      log,
      key,
    ) as Row | undefined;
    return r
      ? { key: String(r["key"]), op: r["op"] as LogRow["op"], version: num(r["version"]) }
      : undefined;
  }
  logAfter(log: LogId, after: number) {
    return (
      this.s(
        "SELECT key, op, version FROM sync_log WHERE log = ? AND version > ? ORDER BY version, ord",
      ).all(log, after) as Row[]
    ).map((r) => ({
      key: String(r["key"]),
      op: r["op"] as LogRow["op"],
      version: num(r["version"]),
    }));
  }
  epoch(log: LogId): Epoch {
    const r = this.s("SELECT n, start FROM sync_epochs WHERE log = ?").get(log) as Row | undefined;
    return r ? { n: num(r["n"]), start: num(r["start"]) } : { n: 0, start: 0 };
  }
  setEpoch(log: LogId, e: Epoch) {
    this.s(
      "INSERT INTO sync_epochs (log, n, start) VALUES (?, ?, ?) ON CONFLICT (log) DO UPDATE SET n = excluded.n, start = excluded.start",
    ).run(log, e.n, e.start);
  }

  private tomb(r: Row): Tombstone {
    return tombOf(r);
  }
  tombGet(key: string) {
    const r = this.s("SELECT * FROM sync_tombstones WHERE key = ?").get(key) as Row | undefined;
    return r ? this.tomb(r) : undefined;
  }
  tombPut(t: Tombstone) {
    this.s(
      "INSERT OR REPLACE INTO sync_tombstones (key, kind, sp, person, who, type, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(t.key, t.kind, t.sp, t.person, t.by, t.type ?? null, t.at);
  }
  tombDelete(key: string) {
    this.s("DELETE FROM sync_tombstones WHERE key = ?").run(key);
  }
  tombsBefore(at: number, limit: number) {
    return (
      this.s("SELECT * FROM sync_tombstones WHERE at < ? ORDER BY at LIMIT ?").all(
        at,
        limit,
      ) as Row[]
    ).map((r) => this.tomb(r));
  }

  private answer(r: Row | undefined): StoredAnswer | undefined {
    return r
      ? { digest: String(r["digest"]), answer: parse(r["answer"]), at: num(r["at"]) }
      : undefined;
  }
  answerGet(u: string, mutationId: string) {
    return this.answer(
      this.s("SELECT digest, answer, at FROM sync_answers WHERE u = ? AND mutation_id = ?").get(
        u,
        mutationId,
      ) as Row | undefined,
    );
  }
  answerPut(u: string, mutationId: string, a: StoredAnswer) {
    this.s(
      "INSERT OR REPLACE INTO sync_answers (u, mutation_id, digest, answer, at) VALUES (?, ?, ?, ?, ?)",
    ).run(u, mutationId, a.digest, json(a.answer), a.at);
  }
  seqAnswerGet(clientId: string, seq: number) {
    return this.answer(
      this.s("SELECT digest, answer, at FROM sync_seq_answers WHERE client_id = ? AND seq = ?").get(
        clientId,
        seq,
      ) as Row | undefined,
    );
  }
  seqAnswerPut(clientId: string, seq: number, a: StoredAnswer) {
    this.s(
      "INSERT OR REPLACE INTO sync_seq_answers (client_id, seq, digest, answer, at) VALUES (?, ?, ?, ?, ?)",
    ).run(clientId, seq, a.digest, json(a.answer), a.at);
  }
  private prune(table: string, col: string, at: number, limit: number) {
    const r = this.s(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? ORDER BY ${col} LIMIT ?)`,
    ).run(at, limit) as { changes?: number };
    return num(r.changes ?? 0);
  }
  answersPrune(at: number, limit: number) {
    return (
      this.prune("sync_answers", "at", at, limit) + this.prune("sync_seq_answers", "at", at, limit)
    );
  }

  private client(r: Row): ClientRec {
    return {
      u: String(r["u"]),
      device: (r["device"] as string | null) ?? null,
      last: num(r["last"]),
      seen: num(r["seen"]),
    };
  }
  clientGet(id: string) {
    const r = this.s("SELECT * FROM sync_clients WHERE id = ?").get(id) as Row | undefined;
    return r ? this.client(r) : undefined;
  }
  clientPut(id: string, c: ClientRec) {
    this.s(
      "INSERT OR REPLACE INTO sync_clients (id, u, device, last, seen) VALUES (?, ?, ?, ?, ?)",
    ).run(id, c.u, c.device, c.last, c.seen);
  }
  clientDelete(id: string) {
    this.s("DELETE FROM sync_clients WHERE id = ?").run(id);
  }
  clientsPrune(at: number, limit: number) {
    return this.prune("sync_clients", "seen", at, limit);
  }
  clientsOfDevice(device: string) {
    return (this.s("SELECT id FROM sync_clients WHERE device = ?").all(device) as Row[]).map((r) =>
      String(r["id"]),
    );
  }
  registrations(u: string, since: number) {
    const r = this.s("SELECT count(*) AS n FROM sync_registrations WHERE u = ? AND at >= ?").get(
      u,
      since,
    ) as Row;
    return num(r["n"]);
  }
  registrationAdd(u: string, at: number) {
    this.s("INSERT INTO sync_registrations (u, at) VALUES (?, ?)").run(u, at);
  }
  registrationsPrune(at: number, limit: number) {
    return this.prune("sync_registrations", "at", at, limit);
  }

  private queued(r: Row): QueuedEffect {
    return {
      id: num(r["id"]),
      effect: parse<Effect>(r["effect"]),
      at: num(r["at"]),
      attempts: num(r["attempts"]),
      next: num(r["next"]),
    };
  }
  effectAdd(effect: Effect, at: number) {
    this.s("INSERT INTO sync_effects (effect, at, attempts, next) VALUES (?, ?, 0, ?)").run(
      json(effect),
      at,
      at,
    );
  }
  effectsDue(now: number, limit: number) {
    return (
      this.s("SELECT * FROM sync_effects WHERE next <= ? ORDER BY next, id LIMIT ?").all(
        now,
        limit,
      ) as Row[]
    ).map((r) => this.queued(r));
  }
  effectUpdate(id: number, attempts: number, next: number) {
    this.s("UPDATE sync_effects SET attempts = ?, next = ? WHERE id = ?").run(attempts, next, id);
  }
  effectDelete(id: number) {
    this.s("DELETE FROM sync_effects WHERE id = ?").run(id);
  }
  deadLetterAdd(d: Omit<DeadLetter, "id">) {
    this.s(
      "INSERT INTO sync_dead_letters (effect, at, attempts, failed_at) VALUES (?, ?, ?, ?)",
    ).run(json(d.effect), d.at, d.attempts, d.failedAt);
  }

  private token(r: Row | undefined): DeviceToken | undefined {
    return r
      ? {
          device: String(r["device"]),
          u: String(r["u"]),
          hash: String(r["hash"]),
          revokedAt: r["revoked_at"] === null ? null : num(r["revoked_at"]),
        }
      : undefined;
  }
  tokenGet(device: string) {
    return this.token(
      this.s("SELECT * FROM sync_device_tokens WHERE device = ?").get(device) as Row | undefined,
    );
  }
  tokenByHash(hash: string) {
    return this.token(
      this.s("SELECT * FROM sync_device_tokens WHERE hash = ?").get(hash) as Row | undefined,
    );
  }
  tokenPut(t: DeviceToken) {
    this.s(
      "INSERT OR REPLACE INTO sync_device_tokens (device, u, hash, revoked_at) VALUES (?, ?, ?, ?)",
    ).run(t.device, t.u, t.hash, t.revokedAt);
  }
  signinGet(request: string) {
    const r = this.s("SELECT body FROM sync_signins WHERE request = ?").get(request) as
      Row | undefined;
    return r ? parse<Signin>(r["body"]) : undefined;
  }
  signinPut(s: Signin) {
    this.s("INSERT OR REPLACE INTO sync_signins (request, body, at) VALUES (?, ?, ?)").run(
      s.request,
      json(s),
      s.at,
    );
  }
  signinsPrune(at: number, limit: number) {
    return this.prune("sync_signins", "at", at, limit);
  }
  leasePut(l: Lease) {
    this.s("INSERT OR REPLACE INTO sync_leases (run, until) VALUES (?, ?)").run(l.run, l.until);
  }
  leaseDelete(run: string) {
    this.s("DELETE FROM sync_leases WHERE run = ?").run(run);
  }
  leasesBefore(at: number, limit: number) {
    return (
      this.s("SELECT run, until FROM sync_leases WHERE until < ? ORDER BY until LIMIT ?").all(
        at,
        limit,
      ) as Row[]
    ).map((r) => ({ run: String(r["run"]), until: num(r["until"]) }));
  }
}

export class SqliteServerStore implements ServerStore {
  private readonly statements = new Map<string, SqliteStatement>();
  private readonly tx: SqliteTx;
  private depth = 0;

  /** A store over `db`, migrated to the package's schema. */
  constructor(private readonly db: SqliteDatabase) {
    migrate(db);
    this.tx = new SqliteTx((sql) => this.stmt(sql));
  }

  private stmt(sql: string): SqliteStatement {
    let s = this.statements.get(sql);
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  transaction<T>(fn: (tx: StoreTx) => T): T {
    if (this.depth > 0) throw new Error("transactions do not nest");
    this.depth++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn(this.tx);
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  records(): Map<string, StoredRecord> {
    return new Map(
      (this.stmt("SELECT key, body FROM sync_records").all() as Row[]).map((r) => [
        String(r["key"]),
        parse<StoredRecord>(r["body"]),
      ]),
    );
  }

  dump(): StoreDump {
    const all = (sql: string) => this.db.prepare(sql).all() as Row[];
    return {
      records: all("SELECT key, body, born FROM sync_records ORDER BY key").map((r) => ({
        key: String(r["key"]),
        record: parse<StoredRecord>(r["body"]),
        born: num(r["born"]),
      })),
      registry: all("SELECT id, rev FROM sync_registry").map((r) => ({
        id: String(r["id"]),
        rev: num(r["rev"]),
      })),
      logRows: all("SELECT log, key, op, version FROM sync_log ORDER BY version, ord").map((r) => ({
        log: r["log"] as LogId,
        key: String(r["key"]),
        op: r["op"] as LogRow["op"],
        version: num(r["version"]),
      })),
      epochs: all("SELECT log, n, start FROM sync_epochs").map((r) => ({
        log: r["log"] as LogId,
        n: num(r["n"]),
        start: num(r["start"]),
      })),
      tombstones: all("SELECT * FROM sync_tombstones ORDER BY at").map(tombOf),
      answers: [
        ...all("SELECT * FROM sync_answers").map((r) => ({
          u: String(r["u"]),
          mutationId: String(r["mutation_id"]),
          digest: String(r["digest"]),
          answer: parse<StoredAnswer["answer"]>(r["answer"]),
          at: num(r["at"]),
        })),
        ...all("SELECT * FROM sync_seq_answers").map((r) => ({
          clientId: String(r["client_id"]),
          seq: num(r["seq"]),
          digest: String(r["digest"]),
          answer: parse<StoredAnswer["answer"]>(r["answer"]),
          at: num(r["at"]),
        })),
      ],
      clients: all("SELECT * FROM sync_clients").map((r) => ({
        clientId: String(r["id"]),
        u: String(r["u"]),
        device: (r["device"] as string | null) ?? null,
        last: num(r["last"]),
        seen: num(r["seen"]),
      })),
      registrations: all("SELECT u, at FROM sync_registrations").map((r) => ({
        u: String(r["u"]),
        at: num(r["at"]),
      })),
      effects: all("SELECT * FROM sync_effects ORDER BY id").map((r) => ({
        id: num(r["id"]),
        effect: parse<Effect>(r["effect"]),
        at: num(r["at"]),
        attempts: num(r["attempts"]),
        next: num(r["next"]),
      })),
      deadLetters: all("SELECT * FROM sync_dead_letters ORDER BY id").map((r) => ({
        id: num(r["id"]),
        effect: parse<Effect>(r["effect"]),
        at: num(r["at"]),
        attempts: num(r["attempts"]),
        failedAt: num(r["failed_at"]),
      })),
      tokens: all("SELECT * FROM sync_device_tokens").map((r) => ({
        device: String(r["device"]),
        u: String(r["u"]),
        hash: String(r["hash"]),
        revokedAt: r["revoked_at"] === null ? null : num(r["revoked_at"]),
      })),
      signins: all("SELECT body FROM sync_signins").map((r) => parse<Signin>(r["body"])),
      leases: all("SELECT run, until FROM sync_leases").map((r) => ({
        run: String(r["run"]),
        until: num(r["until"]),
      })),
    };
  }
}
