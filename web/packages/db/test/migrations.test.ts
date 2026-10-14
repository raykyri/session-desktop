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
    t.deepEqual(
      tables.map((row) => row.name),
      [
        "backfills",
        "collapsed_groups",
        "collapsed_places",
        "embed_assets",
        "feed_items",
        "folders",
        "followup_queue",
        "highlights",
        "interface_drafts",
        "invites",
        "node_messages",
        "node_summaries",
        "nodes",
        "oauth_states",
        "research_drafts",
        "research_images",
        "response_snapshots",
        "run_attempts",
        "run_queue",
        "run_turns",
        "sessions",
        "signup_attempts",
        "tree_folder_membership",
        "tree_invites",
        "tree_members",
        "tree_subscriptions",
        "tree_views",
        "trees",
        "tweet_cache",
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

test("the sharing columns are in the initial schema", (t) => {
  const db = openDatabase(":memory:");
  const columns = (table: string) =>
    (db.$client.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name,
    );
  for (const name of ["role", "invited_by", "archived_at", "trashed_at", "folder_id"]) {
    t.true(columns("tree_members").includes(name), name);
  }
  for (const name of ["visibility", "trashed_by", "parent_tree_id"]) {
    t.true(columns("trees").includes(name), name);
  }
  t.true(columns("nodes").includes("edited_by"));
  closeDatabase(db);
});

test("the node checks tie each body column to the node's type", (t) => {
  const db = openDatabase(":memory:");
  const client = db.$client;
  client.exec(`
    INSERT INTO users (id, github_id, login, created_at, last_login_at)
      VALUES ('u', 1, 'u', 0, 0);
    INSERT INTO workspaces (id, user_id, name, position, created_at, updated_at)
      VALUES ('w', 'u', 'W', 0, 0, 0);
    INSERT INTO trees (id, owner_id, workspace_id, title, root_node_id, created_at, updated_at, position)
      VALUES ('t', 'u', 'w', 'T', 'n', 0, 0, 0);
  `);
  const insert = (id: string, columns: Record<string, string | null>) => {
    const names = ["id", "tree_id", "created_at", ...Object.keys(columns)];
    const values = [id, "t", 0, ...Object.values(columns)];
    client
      .prepare(
        `INSERT INTO nodes (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      )
      .run(...values);
  };
  const message = JSON.stringify({ text: "q" });
  t.notThrows(() =>
    insert("exchange", { type: "exchange", message_json: message, model: "m", status: "queued" }),
  );
  t.notThrows(() => insert("post", { type: "post", message_json: message, format: "text" }));
  t.notThrows(() => insert("document", { type: "document", source: "authored" }));
  // An exchange needs a status and a model; a post or document has no status.
  t.throws(() => insert("e2", { type: "exchange", message_json: message, model: "m" }));
  t.throws(() => insert("e3", { type: "exchange", message_json: message, status: "queued" }));
  t.throws(() =>
    insert("p2", { type: "post", message_json: message, format: "text", status: "queued" }),
  );
  t.throws(() => insert("p3", { type: "post", message_json: message }));
  t.throws(() => insert("p4", { type: "post", format: "text" }));
  t.throws(() => insert("d2", { type: "document" }));
  closeDatabase(db);
});

test("a tree is filed in a folder or the drafts place, not both", (t) => {
  const db = openDatabase(":memory:");
  const client = db.$client;
  client.exec(`
    INSERT INTO users (id, github_id, login, created_at, last_login_at)
      VALUES ('u', 1, 'u', 0, 0);
    INSERT INTO workspaces (id, user_id, name, position, created_at, updated_at)
      VALUES ('w', 'u', 'W', 0, 0, 0);
    INSERT INTO trees (id, owner_id, workspace_id, title, root_node_id, created_at, updated_at, position)
      VALUES ('t1', 'u', 'w', 'T', 'n', 0, 0, 0), ('t2', 'u', 'w', 'T', 'n', 0, 0, 1),
        ('t3', 'u', 'w', 'T', 'n', 0, 0, 2), ('t4', 'u', 'w', 'T', 'n', 0, 0, 3);
    INSERT INTO folders (id, owner_id, workspace_id, name, position, created_at)
      VALUES ('f', 'u', 'w', 'F', 0, 0);
  `);
  const file = client.prepare(
    `INSERT INTO tree_folder_membership (tree_id, folder_id, system_place) VALUES (?, ?, ?)`,
  );
  t.notThrows(() => file.run("t1", "f", null));
  t.notThrows(() => file.run("t2", null, "drafts"));
  t.throws(() => file.run("t3", "f", "drafts"));
  t.throws(() => file.run("t4", null, null));
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
