import { mkdtempSync, rmSync } from "node:fs";
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
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((row) => row.name);
    for (const expected of [
      "users",
      "sessions",
      "workspaces",
      "trees",
      "nodes",
      "highlights",
      "response_snapshots",
      "run_turns",
      "run_queue",
      "journal_entries",
      "encyclopedia_pages",
      "documents",
      "usage_events",
      "backfills",
    ]) {
      t.true(names.includes(expected), `missing table ${expected}`);
    }
    t.is(tableRowCount(db, "users"), 0);
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

test("refuses a database carrying a migration this build does not know", (t) => {
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
    t.true(error?.message.includes("does not know"));
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
