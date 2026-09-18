// Opening the database: pragmas, migrations, and the refusal to run against a
// database this build does not understand
// (`docs/02-domain-model-and-database.md` §4).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import SqliteDatabase from "better-sqlite3";
import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { runBackfills } from "./backfills/index.js";
import * as schema from "./schema/index.js";

export type SessionDatabase = BetterSQLite3Database<typeof schema> & {
  $client: SqliteDatabase.Database;
};

/** The migrations committed alongside this build. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Where drizzle-kit's migrator records what it has applied. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface OpenDatabaseOptions {
  /** Overridden only by tests that exercise migration handling itself. */
  migrationsFolder?: string;
  /** Skip `migrate()` and the migration-drift check. For tooling that has to
   * open a database it is about to migrate by hand. */
  skipMigrations?: boolean;
}

/**
 * Raised when the database carries a migration this build has never seen —
 * the deployed binary is older than the volume it was pointed at. The desktop
 * aborted startup on the same condition (`persistence.rs:403`): applying a new
 * build's schema is safe, running an old build against a new schema is not.
 */
export class UnknownMigrationError extends Error {
  readonly unknownHashes: readonly string[];

  constructor(unknownHashes: readonly string[]) {
    super(
      `Database schema incompatibility: database contains ${unknownHashes.length} unrecognized migration(s). ` +
        "Update the application to a compatible version.",
    );
    this.name = "UnknownMigrationError";
    this.unknownHashes = unknownHashes;
  }
}

function applyPragmas(client: SqliteDatabase.Database, fileBacked: boolean): void {
  if (fileBacked) {
    // WAL needs a file; an in-memory database rejects it and stays in
    // Use `memory` journal mode for in-memory databases.
    client.pragma("journal_mode = WAL");
  }
  client.pragma("synchronous = NORMAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("temp_store = MEMORY");
}

/** Hashes recorded in `__drizzle_migrations`, oldest first. Empty when the
 * table does not exist yet, which is what a fresh database looks like. */
function appliedMigrationHashes(client: SqliteDatabase.Database): string[] {
  const table = client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MIGRATIONS_TABLE);
  if (table === undefined) {
    return [];
  }
  const rows = client
    .prepare(`SELECT hash FROM ${MIGRATIONS_TABLE} ORDER BY created_at ASC`)
    .all() as { hash: string }[];
  return rows.map((row) => row.hash);
}

/**
 * Compares what the database has applied against the migrations bundled with
 * this build. Returns the hashes the build cannot account for.
 */
export function unknownMigrations(
  client: SqliteDatabase.Database,
  migrationsFolder = MIGRATIONS_FOLDER,
): string[] {
  const known = new Set(
    existsSync(migrationsFolder)
      ? readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash)
      : [],
  );
  return appliedMigrationHashes(client).filter((hash) => !known.has(hash));
}

/**
 * Opens (or creates) the database at `path`, applies the pragmas, refuses a
 * database from a newer build, migrates, and runs pending backfills.
 *
 * `":memory:"` gives a private in-memory database for tests where file
 * semantics — WAL, concurrent readers, durability — do not matter.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): SessionDatabase {
  const fileBacked = path !== ":memory:" && path !== "";
  const client = new SqliteDatabase(path);
  applyPragmas(client, fileBacked);
  const db = drizzle(client, { schema });
  if (options.skipMigrations !== true) {
    const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
    const unknown = unknownMigrations(client, migrationsFolder);
    if (unknown.length > 0) {
      client.close();
      throw new UnknownMigrationError(unknown);
    }
    migrate(db, { migrationsFolder });
    runBackfills(db);
  }
  return db;
}

/**
 * Runs `fn` inside a transaction. Every multi-step invariant in
 * `docs/02-domain-model-and-database.md` §5 goes through here.
 *
 * The cast exists because Drizzle types a transaction handle as a distinct
 * class from the database even though the query surface the repositories use
 * is identical; typing every repository against the union would spread that
 * distinction across the package for no benefit. Nesting is a savepoint, so a
 * repository function may call another that transacts.
 */
export function transact<T>(db: SessionDatabase, fn: (tx: SessionDatabase) => T): T {
  return db.transaction((tx) => fn(tx as unknown as SessionDatabase));
}

/** `PRAGMA optimize` and close, the pair the desktop ran on shutdown. */
export function closeDatabase(db: SessionDatabase): void {
  try {
    db.$client.pragma("optimize");
  } finally {
    db.$client.close();
  }
}

/**
 * Runs `fn` in a transaction committed under `synchronous = FULL`.
 *
 * The snapshot commit is the one write whose loss would be visible as a
 * finished run with no answer, so it pays for a durable commit
 * (`docs/00-plan.md` §6); everything else runs under `NORMAL`, where a power
 * loss can cost the last transactions but never the database. The pragma is
 * restored even when the transaction throws.
 *
 * Call it with the database rather than a transaction handle: `PRAGMA
 * synchronous` is a no-op inside an open transaction, so nesting this loses
 * the durability it exists for.
 */
export function withFullSync<T>(db: SessionDatabase, fn: (tx: SessionDatabase) => T): T {
  const previous = db.$client.pragma("synchronous", { simple: true });
  db.$client.pragma("synchronous = FULL");
  try {
    return db.transaction((tx) => fn(tx as unknown as SessionDatabase));
  } finally {
    db.$client.pragma(`synchronous = ${String(previous)}`);
  }
}

/** Number of rows in a table, for tests and operational checks. */
export function tableRowCount(db: SessionDatabase, table: string): number {
  const row = db.get<{ count: number }>(sql.raw(`SELECT COUNT(*) AS count FROM "${table}"`));
  return row?.count ?? 0;
}
