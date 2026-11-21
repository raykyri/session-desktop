// The database's history id and restores (`15-implementation-plan/01-
// architecture-and-data.md` D6, decision E6). A restore from Litestream moves
// the database back in time while clients hold cursors sealed at versions the
// restored database will issue again. Every cursor token and event id holds
// the history id recorded in `server_meta` (`HISTORY_KEY`); a pull whose
// token holds another id answers resync.
//
// At boot the server compares the generation recorded in `server_meta` with
// the generation of the file it opened (`databaseGeneration`). A different
// generation, or none recorded, replaces the history id with a new random
// one, so every cursor served before the restore resyncs, for every log,
// including a log with no rows in the restored file, and including cursors
// served after an earlier restore from the same backup (that backup holds
// the old id, and the new one is random). The current generation is then
// recorded. A boot with the same generation changes nothing.
//
// A restore that keeps the file's identity (bytes copied over the same file,
// or a volume snapshot that keeps the inode and birth time) cannot be told
// from a restart. The operator runs `npm run db:admin -- --new-history`
// against the restored file before the boot (`runbooks/restore.md`); it
// leaves a marker (`RESET_KEY`) that the next boot's check honours and
// removes.
//
// A new generation without a restore (Litestream losing its WAL position,
// under 0.3) replaces the id needlessly and costs each client one resync.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type SqliteDatabase from "better-sqlite3";

import type { SqliteStore } from "./store.js";

/** The `server_meta` key of the generation id. */
export const GENERATION_KEY = "litestream_generation";
/** The `server_meta` key an operator sets to replace the history id at the
 * next boot (`requestNewHistory`). */
export const RESET_KEY = "history_reset_requested";

export interface RestoreCheck {
  /** The generation recorded before this boot. */
  previous: string | null;
  /** The generation of the file now; null for an in-memory database. */
  current: string | null;
  /** Whether the history id was replaced. */
  replaced: boolean;
  /** Why: the generation changed, or the operator asked for it. */
  reason: "generation" | "requested" | null;
  /** The history id after the check. */
  history: string;
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

const metaValue = (db: SqliteDatabase.Database, key: string): string | null =>
  db.prepare<[string], { value: string }>("SELECT value FROM server_meta WHERE key = ?").get(key)
    ?.value ?? null;

const setMeta = (db: SqliteDatabase.Database, key: string, value: string, at: number) =>
  db
    .prepare(
      `INSERT INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, at);

/** A new random history id. */
export const newHistoryId = (): string => randomBytes(16).toString("hex");

/** Ask the next boot to replace the history id: the operator path for a
 * restore that keeps the file's identity (`npm run db:admin --
 * --new-history`). */
export function requestNewHistory(db: SqliteDatabase.Database, at: number = Date.now()): void {
  setMeta(db, RESET_KEY, "1", at);
}

/** The boot-time check of D6. `current` is what `databaseGeneration`
 * reports; with null (no file) the generation is not compared or recorded,
 * and only an operator's request replaces the id. */
export function checkRestore(store: SqliteStore, current: string | null, at: number): RestoreCheck {
  const db = store.sqlite;
  return store.transaction(() => {
    const previous = metaValue(db, GENERATION_KEY);
    const requested = metaValue(db, RESET_KEY) !== null;
    const moved = current !== null && previous !== current;
    const reason = moved ? "generation" : requested ? "requested" : null;
    if (reason !== null) store.setHistory(newHistoryId());
    if (moved) setMeta(db, GENERATION_KEY, current, at);
    if (requested) db.prepare("DELETE FROM server_meta WHERE key = ?").run(RESET_KEY);
    return { previous, current, replaced: reason !== null, reason, history: store.history() };
  });
}
