import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import test from "ava";
import SqliteDatabase from "better-sqlite3";

import {
  MIGRATIONS_FOLDER,
  UnknownMigrationError,
  closeDatabase,
  openDatabase,
  runBackfills,
  tableRowCount,
  unknownMigrations,
} from "../src/index.js";

test("applies every migration to an empty database", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-migrate-"));
  const path = join(directory, "session.db");
  try {
    const db = openDatabase(path);
    const tables = db.$client
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    // The whole set, so a table the schema no longer declares is caught too:
    // the general tables, the run tables, API keys, and @session/sync's
    // tables (its migrations, applied by `openDatabase` after these).
    t.deepEqual(
      tables.map((row) => row.name),
      [
        "api_keys",
        "backfills",
        "invites",
        "oauth_states",
        "run_attempts",
        "run_queue",
        "sessions",
        "signup_attempts",
        "sync_answers",
        "sync_clients",
        "sync_dead_letters",
        "sync_device_runs",
        "sync_device_tokens",
        "sync_effects",
        "sync_epochs",
        "sync_index",
        "sync_leases",
        "sync_log",
        "sync_meta",
        "sync_migrations",
        "sync_records",
        "sync_registrations",
        "sync_registry",
        "sync_seq_answers",
        "sync_signins",
        "sync_tombstones",
        "uploads",
        "usage_events",
        "user_limits",
        "user_preferences",
        "users",
      ],
    );
    t.is(tableRowCount(db, "users"), 0);
    closeDatabase(db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the history is a single initial migration", (t) => {
  // The database has never been deployed with this schema; the history stays
  // flat until it is (runbooks/reset-database.md).
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  t.deepEqual(
    journal.entries.map((entry) => entry.tag),
    ["0000_initial"],
  );
  t.deepEqual(
    readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith(".sql")),
    ["0000_initial.sql"],
  );
});

test("the hot lookups have indexes", (t) => {
  const db = openDatabase(":memory:");
  const indexed = (table: string, column: string) =>
    (db.$client.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).some(
      (index) => {
        const columns = db.$client.prepare(`PRAGMA index_info(${index.name})`).all() as {
          seqno: number;
          name: string;
        }[];
        return columns.some((entry) => entry.seqno === 0 && entry.name === column);
      },
    );
  for (const [table, column] of [
    ["usage_events", "user_id"],
    ["api_keys", "user_id"],
    ["run_queue", "claimed_at"],
    ["users", "handle"],
  ] as const) {
    t.true(indexed(table, column), `${table}.${column}`);
  }
  closeDatabase(db);
});

test("the sync store's migrations are recorded once", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-sync-"));
  const path = join(directory, "session.db");
  try {
    closeDatabase(openDatabase(path));
    const db = openDatabase(path);
    const names = (
      db.$client.prepare("SELECT name FROM sync_migrations ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    t.deepEqual(names, [
      "0001_sync.sql",
      "0002_review_r1.sql",
      "0003_space_vis.sql",
      "0004_review_r1_phase2.sql",
      "0005_review_r2_phase2.sql",
    ]);
    closeDatabase(db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applies the file pragmas", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-pragma-"));
  try {
    const db = openDatabase(join(directory, "session.db"));
    t.is(db.$client.pragma("journal_mode", { simple: true }), "wal");
    t.is(db.$client.pragma("foreign_keys", { simple: true }), 1);
    t.is(db.$client.pragma("synchronous", { simple: true }), 1);
    closeDatabase(db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an in-memory database skips WAL but keeps the rest", (t) => {
  const db = openDatabase(":memory:");
  t.is(db.$client.pragma("journal_mode", { simple: true }), "memory");
  t.is(db.$client.pragma("foreign_keys", { simple: true }), 1);
  closeDatabase(db);
});

test("rejects a database containing a migration unsupported by this build", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-unknown-"));
  const path = join(directory, "session.db");
  try {
    closeDatabase(openDatabase(path));
    // A future build's migration, recorded as applied.
    const client = new SqliteDatabase(path);
    client
      .prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
      .run("0".repeat(64), Date.now() + 1000);
    t.deepEqual(unknownMigrations(client, MIGRATIONS_FOLDER), ["0".repeat(64)]);
    client.close();
    const error = t.throws(() => openDatabase(path), { instanceOf: UnknownMigrationError });
    t.true(error?.message.includes("unrecognized migration"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("records a backfill once", (t) => {
  const db = openDatabase(":memory:");
  let runs = 0;
  const steps = [
    {
      id: "0001-example",
      description: "counts its own executions",
      run: () => {
        runs += 1;
      },
    },
  ];
  t.deepEqual(runBackfills(db, steps), ["0001-example"]);
  t.deepEqual(runBackfills(db, steps), []);
  t.is(runs, 1);
  closeDatabase(db);
});
