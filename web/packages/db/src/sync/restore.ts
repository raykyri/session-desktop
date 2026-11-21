// Log epochs and restores (`15-implementation-plan/01-architecture-and-
// data.md` D6, decision E6). A restore from Litestream moves the database
// back in time while clients hold cursors sealed at versions the restored
// database will issue again. At boot the server compares the generation id
// recorded in `server_meta` with the generation of the file it opened; a
// different id, or none recorded, bumps the epoch of every log, so every
// cursor issued before the restore resyncs, and the current id is recorded.
// A boot with the same id bumps nothing. What the id is under Litestream 0.5,
// which has no generations, is `databaseGeneration`'s.
//
// A new generation without a restore (Litestream losing its WAL position,
// under 0.3) bumps the epochs needlessly and costs each client one resync.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { LogId } from "@session/mutators";

import type { SqliteStore } from "./store.js";

/** The `server_meta` key of the generation id. */
export const GENERATION_KEY = "litestream_generation";

export interface RestoreCheck {
  /** The id recorded before this boot. */
  previous: string | null;
  /** The id of the file now; null for an in-memory database. */
  current: string | null;
  /** The logs whose epoch was bumped. */
  bumped: number;
}

/**
 * The generation of the database file at `databasePath`, or null when there
 * is no file (an in-memory database).
 *
 * Litestream keeps its state beside the database in `.<name>-litestream/`.
 * Releases up to 0.3 write the current generation id to its `generation`
 * file, and that id is used when it is there. Litestream 0.5 (the image's)
 * has no generations: it writes LTX files whose names change as it compacts
 * them. There the generation is the identity of the database file itself
 * (device, inode and creation time), which changes exactly when the file is
 * replaced: `litestream restore` writes a new file that the runbook moves
 * into place, and `-restore-if-db-not-exists` writes one on a new volume. A
 * restart, a deploy or a volume remount keeps it.
 */
export function databaseGeneration(databasePath: string): string | null {
  if (databasePath === ":memory:" || databasePath === "" || !existsSync(databasePath)) return null;
  const file = join(dirname(databasePath), `.${basename(databasePath)}-litestream`, "generation");
  if (existsSync(file)) {
    const id = readFileSync(file, "utf8").trim();
    if (id !== "") return `litestream:${id}`;
  }
  const st = statSync(databasePath, { bigint: true });
  return `file:${st.dev}:${st.ino}:${st.birthtimeMs}`;
}

function recorded(store: SqliteStore): string | null {
  const row = store.sqlite
    .prepare<[string], { value: string }>("SELECT value FROM server_meta WHERE key = ?")
    .get(GENERATION_KEY);
  return row?.value ?? null;
}

/** Every log the change log or the epoch table names. */
function allLogs(store: SqliteStore): LogId[] {
  return store.sqlite
    .prepare<[], { log: LogId }>(
      "SELECT DISTINCT log FROM change_log UNION SELECT log FROM log_epochs ORDER BY log",
    )
    .all()
    .map((r) => r.log);
}

/** Bump the epoch of every log: a new history for each, beginning at one new
 * version, as `SyncServer.replaceHistory` does for one log. Returns how many
 * logs it bumped. */
export function bumpEveryEpoch(store: SqliteStore): number {
  return store.transaction(() => {
    const logs = allLogs(store);
    if (!logs.length) return 0;
    const start = store.nextVersion();
    for (const log of logs) store.setEpoch(log, { n: store.epoch(log).n + 1, start });
    return logs.length;
  });
}

/** The boot-time check of D6. `current` is what `databaseGeneration`
 * reports; with null (no file) nothing is compared or recorded. */
export function checkRestore(store: SqliteStore, current: string | null, at: number): RestoreCheck {
  const previous = recorded(store);
  if (current === null || previous === current) return { previous, current, bumped: 0 };
  return store.transaction(() => {
    const bumped = bumpEveryEpoch(store);
    store.sqlite
      .prepare(
        `INSERT INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(GENERATION_KEY, current, at);
    return { previous, current, bumped };
  });
}
