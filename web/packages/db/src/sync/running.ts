// Whether a server process has the database open (`runbooks/delete-account.md`).
// The server caches records in memory (`SqliteStore`), so an operator job
// that writes records while it runs would leave that cache stale: the server
// would keep serving what the job deleted, and a channel the job froze would
// still take posts. The server keeps a heartbeat row in `server_meta`,
// written at boot and every `HEARTBEAT_INTERVAL_MS`, and deleted when it
// shuts down; a job that writes records refuses while the row is fresh.
//
// A server that was killed leaves its row: the job waits until it is
// `HEARTBEAT_STALE_MS` old. A row is a database fact, so the check holds for
// any process with the file, on this machine or another one with the volume.

import type SqliteDatabase from "better-sqlite3";

import type { SessionDatabase } from "../connection.js";

/** The `server_meta` key of the heartbeat. */
export const HEARTBEAT_KEY = "server_heartbeat";
/** How often a running server writes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this is a server that stopped without its
 * shutdown (a crash, a kill): three missed beats. */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS;

const client = (db: SessionDatabase | SqliteDatabase.Database) =>
  "$client" in db ? db.$client : db;

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
 * has the database open. */
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

/** Throws when a server has the database open: an operator job that writes
 * records runs with the server stopped. */
export function assertServerStopped(
  db: SessionDatabase | SqliteDatabase.Database,
  at: number,
  job: string,
): void {
  const running = runningServer(db, at);
  if (!running) return;
  const ago = Math.max(0, Math.round((at - running.at) / 1000));
  throw new Error(
    `${job} needs the server stopped: a server (${running.value}) wrote its heartbeat ${ago} s ago. ` +
      `Stop it and run this again; a server that was killed is taken as stopped ` +
      `${HEARTBEAT_STALE_MS / 1000} s after its last heartbeat.`,
  );
}
