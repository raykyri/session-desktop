// Whether a server process has the database open (`runbooks/delete-account.md`).
// The server caches records in memory (`SqliteStore`), so an operator job
// that writes records while it runs would leave that cache stale: the server
// would keep serving what the job deleted, and a channel the job froze would
// still take posts. The server keeps a heartbeat row in `server_meta`,
// written right after it opens the database and every
// `HEARTBEAT_INTERVAL_MS`, and deleted when it shuts down; a job that writes
// records refuses while the row is fresh.
//
// A server that was killed leaves its row: the job waits until it is
// `HEARTBEAT_STALE_MS` old. A row is a database fact, so the check holds for
// any process with the file, on this machine or another one with the volume.
//
// The heartbeat misses a process that has the file open and has not written
// a fresh row: a server between `openDatabase()` and its first beat, a build
// without the heartbeat, a server whose last beat is older than
// `HEARTBEAT_STALE_MS`, or Litestream. The job therefore also takes an
// exclusive lock on the file (`lockDatabase`) and holds it while it writes
// or deletes: in WAL mode SQLite refuses that lock with SQLITE_BUSY while any
// other connection has the database open, idle or not. In rollback-journal
// mode an idle connection holds no lock, so there the lock only shows a
// connection inside a transaction.

import type SqliteDatabase from "better-sqlite3";

import type { SessionDatabase } from "../connection.js";

/** The `server_meta` key of the heartbeat. */
export const HEARTBEAT_KEY = "server_heartbeat";
/** How often a running server writes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this is a server that stopped without its
 * shutdown (a crash, a kill): three missed beats. */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS;

/** An operator job refused because a server has, or may have, the database
 * open: a fresh heartbeat, or another connection holding the file. */
export class ServerRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerRunningError";
  }
}

const client = (db: SessionDatabase | SqliteDatabase.Database) =>
  "$client" in db ? db.$client : db;

/** Whether `error` is SQLite's SQLITE_BUSY (or one of its extended codes). */
export function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** Writes the heartbeat: the time `at`, and this process's id for the
 * operator's message. */
export function writeHeartbeat(db: SessionDatabase | SqliteDatabase.Database, at: number): void {
  client(db)
    .prepare(
      `INSERT INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(HEARTBEAT_KEY, `pid ${process.pid}`, at);
}

/** Deletes the heartbeat: the server is shutting down. */
export function clearHeartbeat(db: SessionDatabase | SqliteDatabase.Database): void {
  client(db).prepare("DELETE FROM server_meta WHERE key = ?").run(HEARTBEAT_KEY);
}

/** The server's last heartbeat when it is fresh at `at`, or null: no server
 * has the database open. A heartbeat dated after `at` counts as fresh. */
export function runningServer(
  db: SessionDatabase | SqliteDatabase.Database,
  at: number,
): { value: string; at: number } | null {
  const row = client(db)
    .prepare<[string], { value: string; updated_at: number }>(
      "SELECT value, updated_at FROM server_meta WHERE key = ?",
    )
    .get(HEARTBEAT_KEY);
  if (!row || at - row.updated_at >= HEARTBEAT_STALE_MS) return null;
  return { value: row.value, at: row.updated_at };
}

/** Throws `ServerRunningError` while the heartbeat is fresh at `at`. */
export function assertNoFreshHeartbeat(
  db: SessionDatabase | SqliteDatabase.Database,
  at: number,
  job: string,
): void {
  const running = runningServer(db, at);
  if (!running) return;
  const seconds = Math.round((at - running.at) / 1000);
  const when =
    running.at > at
      ? `a heartbeat dated ${Math.max(1, -seconds)} s ahead of this machine's clock`
      : `its heartbeat ${seconds} s ago`;
  throw new ServerRunningError(
    `${job} needs the server stopped: a server (${running.value}) wrote ${when}. ` +
      `Stop it and run this again; a server that was killed is taken as stopped ` +
      `${HEARTBEAT_STALE_MS / 1000} s after its last heartbeat.`,
  );
}

/**
 * Takes an exclusive lock on the database file through `db`'s own
 * connection and keeps it until the returned function is called or the
 * connection closes: `locking_mode = EXCLUSIVE`, then `BEGIN IMMEDIATE`
 * with no busy timeout. While the lock is held no other process can open
 * the database. Throws `ServerRunningError` when SQLite answers SQLITE_BUSY,
 * which in WAL mode it does while any other connection has the file open.
 * Other errors (a file that is not a database) are thrown as they are.
 */
export function lockDatabase(
  db: SessionDatabase | SqliteDatabase.Database,
  job: string,
): () => void {
  const c = client(db);
  const timeout = c.pragma("busy_timeout", { simple: true }) as number;
  c.pragma("busy_timeout = 0");
  try {
    c.pragma("locking_mode = EXCLUSIVE");
    // the lock outlives the transaction in exclusive locking mode
    c.exec("BEGIN IMMEDIATE");
    c.exec("ROLLBACK");
  } catch (error) {
    c.pragma("locking_mode = NORMAL");
    if (isBusyError(error))
      throw new ServerRunningError(
        `${job} needs the server stopped: another process has the database open ` +
          "(SQLite answered SQLITE_BUSY to an exclusive lock). Stop the app and every " +
          "process using the file (a server, Litestream, another operator command) and run this again.",
      );
    throw error;
  } finally {
    c.pragma(`busy_timeout = ${timeout}`);
  }
  return () => {
    c.pragma("locking_mode = NORMAL");
    // in normal mode the lock is released at the next access of the file
    c.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
  };
}

/** Throws `ServerRunningError` when a server has the database open: its
 * heartbeat is fresh at `at`, or another connection holds the file. On
 * success `db`'s connection holds an exclusive lock on the file
 * (`lockDatabase`) until the returned function is called: an operator job
 * that writes records runs with the server stopped, and no server can start
 * while it runs. */
export function assertServerStopped(
  db: SessionDatabase | SqliteDatabase.Database,
  at: number,
  job: string,
): () => void {
  assertNoFreshHeartbeat(db, at, job);
  return lockDatabase(db, job);
}
