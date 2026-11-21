// The database reset (`web/docs/runbooks/reset-database.md`; plan `05`
// §3.5, §3.6 step 4): delete the database, its WAL and shared-memory files,
// Litestream's local state beside them and the volume's data directories, so
// that the next boot builds an empty database from `0000_initial.sql`.
//
// It follows the rule of the account-deletion job (`delete-account.md`): an
// operator job that writes runs with the server stopped, and it checks that
// in two ways (`@session/db` `sync/running.ts`):
//
// - The lock: the reset opens `session.db` read-write in exclusive locking
//   mode with no busy timeout and takes `BEGIN IMMEDIATE`. In WAL mode SQLite
//   answers SQLITE_BUSY while any other connection has the file open (a
//   server, Litestream, another operator command), and the reset refuses.
//   It holds the lock while it deletes, so no server can open the file in
//   between.
// - The heartbeat: a server writes a row in `server_meta` right after it
//   opens the database and every 30 s, and deletes it at the end of its
//   shutdown; the reset refuses while that row is under 90 s old (a server
//   killed moments ago, on this machine or another).
//
// A database made by an older build may have no `server_meta` table, and a
// file that is not a SQLite database, or is corrupt, cannot be read at all:
// in both cases there is no heartbeat to read, and the reset refuses unless
// the operator passes `assumeStopped`, having checked that no machine of the
// app is running. The lock is still taken wherever SQLite can open the file.
// With no `session.db` at all, nothing shows that the directory is a Session
// data directory, and deleting needs `noDatabase`.
//
// Without `apply` it only lists what it would delete. Opening the database
// read-write creates a `-wal` file where there was none; the reset deletes
// the `-wal` and `-shm` files it created before it lets go of the lock. On a
// database a killed server left with a WAL, closing the connection
// checkpoints that WAL into the file: its committed data stays.

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ServerRunningError, assertNoFreshHeartbeat, isBusyError, lockDatabase } from "@session/db";
import SqliteDatabase from "better-sqlite3";

export interface ResetInput {
  /** The data directory (`SESSION_DATA_DIR`), which holds `session.db`. */
  dataDir: string;
  /** Delete; otherwise list what would be deleted. */
  apply: boolean;
  /** Proceed on a database with no heartbeat to read: no `server_meta`
   * table, or a file SQLite cannot read. The lock is taken all the same. */
  assumeStopped?: boolean;
  /** Delete although `session.db` does not exist. */
  noDatabase?: boolean;
  /** The time the heartbeat is compared with. */
  now?: number;
}

export interface ResetReport {
  /** How the server was found stopped: by its heartbeat, by the operator's
   * word for a database without one, or no database file. */
  stopped: "heartbeat" | "assumed" | "no database";
  /** Whether the reset held an exclusive lock on `session.db` (no other
   * process had it open); false with no database, or a file SQLite could not
   * lock. */
  locked: boolean;
  /** SQLite's error for a `session.db` it cannot read: not a database, or
   * corrupt. */
  unreadable?: string;
  /** The paths deleted, or that would be deleted without `apply`. */
  paths: string[];
  applied: boolean;
}

/** A reset that did not run: the server is running, or may be, or the
 * directory does not look like a data directory. */
export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetRefusedError";
  }
}

const DATABASE = "session.db";
const JOB = "The database reset";

/** The paths under `dataDir` the reset follows into: a symlink at one of
 * them would make it delete or lock whatever the link points at. */
const NO_SYMLINK = [DATABASE, "documents", "embeds"];

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

function refuseSymlinks(dataDir: string): void {
  for (const name of NO_SYMLINK) {
    const path = join(dataDir, name);
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {
      // absent
    }
    if (link)
      throw new ResetRefusedError(
        `${path} is a symbolic link; the reset deletes only files inside the data directory. ` +
          "Remove the link or point --data-dir at the directory that holds the files.",
      );
  }
}

/** SQLite's answer for a file that is not a database, or a damaged one. */
function unreadableError(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_(NOTADB|CORRUPT)/.test(code)
    ? (error as Error).message
    : null;
}

interface Probe {
  stopped: "heartbeat" | "assumed";
  /** The locked connection, or null when SQLite could not lock the file. */
  client: SqliteDatabase.Database | null;
  unreadable?: string;
}

/** Opens `path` in exclusive locking mode and takes the lock, then reads the
 * heartbeat. Throws `ResetRefusedError`, holding nothing, when another
 * process has the file open, the heartbeat is fresh, or there is no
 * heartbeat to read and `assumeStopped` is not given. */
function probe(path: string, input: ResetInput): Probe {
  const client = new SqliteDatabase(path, { fileMustExist: true, timeout: 0 });
  let locked = false;
  try {
    // before the first read, so SQLite keeps the WAL index in this process's
    // memory and creates no -shm file
    client.pragma("locking_mode = EXCLUSIVE");
    let unreadable: string | null = null;
    let hasMeta = false;
    try {
      lockDatabase(client, JOB);
      locked = true;
      hasMeta =
        client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_meta'")
          .get() !== undefined;
    } catch (error) {
      unreadable = unreadableError(error);
      if (unreadable === null) throw error;
    }
    if (unreadable !== null || !hasMeta) {
      if (input.assumeStopped !== true) {
        const why =
          unreadable !== null
            ? `${path} cannot be read as a SQLite database (${unreadable}), so no server heartbeat can be read` +
              (locked
                ? "; no other process has it open."
                : ", and SQLite could not lock it to check that no other process has it open.")
            : `${path} has no server_meta table, so no server heartbeat can be read; no other process has it open.`;
        throw new ResetRefusedError(
          `${why} Stop the app (fly scale count 0), check that \`fly machine list\` shows no other ` +
            "started machine, and run this again with --assume-stopped.",
        );
      }
      return {
        stopped: "assumed",
        client: locked ? client : null,
        ...(unreadable !== null ? { unreadable } : {}),
      };
    }
    // the heartbeat counts with --assume-stopped too: a server killed less
    // than 90 s ago may be restarting
    assertNoFreshHeartbeat(client, input.now ?? Date.now(), JOB);
    return { stopped: "heartbeat", client };
  } catch (error) {
    client.close();
    if (error instanceof ServerRunningError) throw new ResetRefusedError(error.message);
    if (isBusyError(error))
      throw new ResetRefusedError(`${JOB} needs the server stopped: ${(error as Error).message}`);
    throw error;
  } finally {
    if (!locked && client.open) client.close();
  }
}

/** Checks that no server has the database open, then deletes (with `apply`)
 * or lists the reset's targets, holding an exclusive lock on `session.db`
 * while it deletes. Throws `ResetRefusedError`, deleting nothing, while a
 * server may have the database open. */
export function resetDatabase(input: ResetInput): ResetReport {
  refuseSymlinks(input.dataDir);
  const path = join(input.dataDir, DATABASE);
  // before the database is opened: the -wal file the open creates is not a
  // target, it is removed below
  const paths = resetTargets(input.dataDir);
  if (!existsSync(path)) {
    if (input.apply && paths.length > 0 && input.noDatabase !== true)
      throw new ResetRefusedError(
        `There is no ${path}, so nothing shows that ${input.dataDir} is a Session data directory. ` +
          "Check --data-dir and SESSION_DATA_DIR; to delete the paths listed without --yes, " +
          "run this again with --yes --no-database.",
      );
    if (input.apply) for (const target of paths) rmSync(target, { recursive: true, force: true });
    return { stopped: "no database", locked: false, paths, applied: input.apply };
  }
  const found = probe(path, input);
  try {
    if (input.apply) for (const target of paths) rmSync(target, { recursive: true, force: true });
    // still under the lock: no other process can be using these
    for (const own of [`${path}-wal`, `${path}-shm`])
      if (!paths.includes(own)) rmSync(own, { force: true });
  } finally {
    found.client?.close();
  }
  return {
    stopped: found.stopped,
    locked: found.client !== null,
    ...(found.unreadable !== undefined ? { unreadable: found.unreadable } : {}),
    paths,
    applied: input.apply,
  };
}
