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
    // The whole set, so a table the schema no longer declares is caught too.
    // The research tables are still created by `0000_initial.sql`, though
    // the schema no longer declares them; M8a squashes the migrations into
    // one generated from the schema, and this list loses them then (plan
    // `01` D5).
    t.deepEqual(
      tables.map((row) => row.name),
      [
        "api_keys",
        "backfills",
        "collapsed_groups",
        "collapsed_places",
        "embed_assets",
        "feed_items",
        "folders",
        "followup_queue",
        "highlights",
        "image_refs",
        "interface_drafts",
        "invites",
        "node_messages",
        "node_summaries",
        "nodes",
        "notifications",
        "oauth_states",
        "research_drafts",
        "research_images",
        "response_snapshots",
        "run_attempts",
        "run_queue",
        "run_turns",
        "sessions",
        "signup_attempts",
        "site_settings",
        "tree_folder_membership",
        "tree_invites",
        "tree_member_removals",
        "tree_members",
        "tree_subscriptions",
        "tree_views",
        "trees",
        "tweet_cache",
        "usage_billing",
        "usage_events",
        "user_limits",
        "user_preferences",
        "users",
        "widget_revisions",
        "widget_state",
        "workspaces",
      ],
    );
    t.is(tableRowCount(db, "users"), 0);
    closeDatabase(db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the history is the initial migration and the API keys migration", (t) => {
  // The database has never been deployed with this schema; M8a squashes the
  // history into one initial migration (runbooks/reset-database.md, plan
  // `01` D5). `0003_api_keys` is numbered apart from the migrations other
  // milestones add beside it.
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  t.deepEqual(
    journal.entries.map((entry) => entry.tag),
    ["0000_initial", "0003_api_keys"],
  );
  t.deepEqual(
    readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith(".sql")),
    ["0000_initial.sql", "0003_api_keys.sql"],
  );
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
