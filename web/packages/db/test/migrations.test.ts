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
        "change_log",
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
        "log_epochs",
        "node_messages",
        "node_summaries",
        "nodes",
        "notifications",
        "oauth_states",
        "records",
        "registry",
        "research_drafts",
        "research_images",
        "response_snapshots",
        "run_attempts",
        "run_live",
        "run_queue",
        "run_turns",
        "save_counts",
        "server_head",
        "server_meta",
        "sessions",
        "signup_attempts",
        "site_settings",
        "sync_answers",
        "sync_clients",
        "sync_seq_answers",
        "tombstones",
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

test("the history is the initial migration and the plan's numbered ones", (t) => {
  // The database has never been deployed with this schema; M8a squashes the
  // history into one initial migration (runbooks/reset-database.md, plan
  // `01` D5). Each milestone adds its own numbered migration beside it:
  // `0003_api_keys` (M5b), `0004_accounts` (M6), `0005_spaces` (M3; the
  // plan's `0001_spaces`, numbered after the ones that landed first).
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  t.deepEqual(
    journal.entries.map((entry) => entry.tag),
    ["0000_initial", "0003_api_keys", "0004_accounts", "0005_spaces"],
  );
  t.deepEqual(
    readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .sort(),
    ["0000_initial.sql", "0003_api_keys.sql", "0004_accounts.sql", "0005_spaces.sql"],
  );
});

test("journal entries ascend in idx and strictly in when", (t) => {
  // The migrator applies only entries whose `when` is later than the last
  // applied one, so an entry out of order would be skipped silently on a
  // database that already has a later one.
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  for (let index = 1; index < journal.entries.length; index += 1) {
    const previous = journal.entries[index - 1]!;
    const entry = journal.entries[index]!;
    t.true(entry.idx > previous.idx, `${entry.tag} idx after ${previous.tag}`);
    t.true(entry.when > previous.when, `${entry.tag} when after ${previous.tag}`);
    t.true(entry.tag.startsWith(String(entry.idx).padStart(4, "0")), `${entry.tag} matches idx`);
  }
});

test("0005_spaces creates the records indexes of 01 D1 and the change log's, and seeds the server head", (t) => {
  const db = openDatabase(":memory:");
  const indexes = (table: string) =>
    (db.$client.prepare(`PRAGMA index_list(\`${table}\`)`).all() as { name: string }[]).flatMap(
      (row) =>
        row.name.startsWith("sqlite_")
          ? []
          : [
              `${row.name}(${(
                db.$client.prepare(`PRAGMA index_info(\`${row.name}\`)`).all() as { name: string }[]
              )
                .map((c) => c.name)
                .join(",")})`,
            ],
    );
  t.deepEqual(indexes("records").sort(), [
    "records_kind_sp_idx(kind,sp,created_v)",
    "records_kind_th_idx(kind,th,created_v)",
    "records_kind_u_idx(kind,u)",
    "records_kind_uniq_unique(kind,uniq)",
  ]);
  t.true(indexes("change_log").includes("change_log_version_idx(log,version)"));
  t.deepEqual(db.$client.prepare("SELECT id, version FROM server_head").all(), [
    { id: 1, version: 0 },
  ]);
  // every lookup of the store is answered by an index (`01` U2)
  for (const q of [
    "SELECT key FROM records WHERE kind = 'thread' AND sp = 'x'",
    "SELECT key FROM records WHERE kind = 'node' AND th = 'x'",
    "SELECT key FROM records WHERE kind = 'save' AND u = 'x'",
    "SELECT key FROM records WHERE kind = 'space' AND uniq = 'x'",
    "SELECT key, op, version FROM change_log WHERE log = 'x' AND version > 0 ORDER BY version",
  ]) {
    const plan = (db.$client.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join("; ");
    t.regex(plan, /USING (COVERING )?INDEX/, q);
  }
  t.is(db.$client.pragma("secure_delete", { simple: true }), 1);
  closeDatabase(db);
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
