// The database reset (`web/docs/runbooks/reset-database.md`; plan `05`
// §3.5, §3.6 step 4): delete the database, its WAL and shared-memory files,
// Litestream's local state beside them and the volume's data directories, so
// that the next boot builds an empty database from `0000_initial.sql`.
//
// It follows the rule of the account-deletion job (`delete-account.md`): an
// operator job that writes runs with the server stopped. A server writes a
// heartbeat row in `server_meta` at boot and every 30 s and deletes it at the
// end of its shutdown (`@session/db` `sync/running.ts`); the reset refuses
// while that row is under 90 s old and deletes nothing. A database made by
// an older build may have no `server_meta` table, and so no heartbeat to
// read: the reset then refuses unless the operator passes `assumeStopped`,
// having checked that no machine of the app is running.
//
// Without `apply` it only lists what it would delete.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assertServerStopped } from "@session/db";
import SqliteDatabase from "better-sqlite3";

export interface ResetInput {
  /** The data directory (`SESSION_DATA_DIR`), which holds `session.db`. */
  dataDir: string;
  /** Delete; otherwise list what would be deleted. */
  apply: boolean;
  /** Proceed on a database with no `server_meta` table (no heartbeat). */
  assumeStopped?: boolean;
  /** The time the heartbeat is compared with. */
  now?: number;
}

export interface ResetReport {
  /** How the server was found stopped: by its heartbeat, by the operator's
   * word for a database without one, or no database file. */
  stopped: "heartbeat" | "assumed" | "no database";
  /** The paths deleted, or that would be deleted without `apply`. */
  paths: string[];
  applied: boolean;
}

/** A reset that did not run: the server is running, or may be. */
export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetRefusedError";
  }
}

const DATABASE = "session.db";

/** What the reset deletes under `dataDir`, existing paths only. The
 * directories `documents/` and `tmp/` stay (the entrypoint makes them), and
 * `tmp/vertex-credentials.json`, rewritten at every boot, stays too. */
export function resetTargets(dataDir: string): string[] {
  const paths = [
    DATABASE,
    `${DATABASE}-wal`,
    `${DATABASE}-shm`,
    // Litestream's local state for the deleted database (`privacyCheck.ts`
    // `litestreamDir`); it describes a file that no longer exists.
    `.${DATABASE}-litestream`,
    // The embedded-post image cache of the earlier build; nothing reads it
    // now.
    "embeds",
    // The stamp of the last documents archive: without it the first archive
    // under a new replica prefix is a full one (`restore.md` §3).
    join("tmp", "documents-backup.stamp"),
  ].map((name) => join(dataDir, name));
  const documents = join(dataDir, "documents");
  if (existsSync(documents)) {
    for (const name of readdirSync(documents)) paths.push(join(documents, name));
  }
  return paths.filter((path) => existsSync(path));
}

function checkStopped(path: string, input: ResetInput): ResetReport["stopped"] {
  if (!existsSync(path)) return "no database";
  const client = new SqliteDatabase(path, { readonly: true, fileMustExist: true });
  try {
    const meta = client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_meta'")
      .get();
    if (meta === undefined) {
      if (input.assumeStopped === true) return "assumed";
      throw new ResetRefusedError(
        `${path} has no server_meta table, so no server heartbeat can be read. ` +
          "Stop the app (fly scale count 0), check that `fly machine list` shows no other " +
          "started machine, and run this again with --assume-stopped.",
      );
    }
    try {
      assertServerStopped(client, input.now ?? Date.now(), "The database reset");
    } catch (error) {
      throw new ResetRefusedError((error as Error).message);
    }
    return "heartbeat";
  } finally {
    client.close();
  }
}

/** Checks that no server has the database open, then deletes (with `apply`)
 * or lists the reset's targets. Throws `ResetRefusedError`, deleting
 * nothing, while a server's heartbeat is fresh. */
export function resetDatabase(input: ResetInput): ResetReport {
  const stopped = checkStopped(join(input.dataDir, DATABASE), input);
  const paths = resetTargets(input.dataDir);
  if (input.apply) {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  }
  return { stopped, paths, applied: input.apply };
}
