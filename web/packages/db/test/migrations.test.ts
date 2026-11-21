import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import test from "ava";
import SqliteDatabase from "better-sqlite3";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";

import {
  MIGRATIONS_FOLDER,
  UnappliedMigrationError,
  UnknownMigrationError,
  closeDatabase,
  openDatabase,
  runBackfills,
  tableRowCount,
  unappliedMigrations,
  unknownMigrations,
} from "../src/index.js";
import * as schema from "../src/schema/index.js";

/** The part of `drizzle-kit/api` the snapshot test uses, typed here: the
 * package's own declarations do not resolve under the lint's project. */
interface DrizzleKitApi {
  generateSQLiteDrizzleJson(imports: Record<string, unknown>, prevId?: string): Promise<unknown>;
  generateSQLiteMigration(prev: unknown, cur: unknown): Promise<string[]>;
}

interface Snapshot {
  id: string;
  prevId: string;
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(folder = MIGRATIONS_FOLDER): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
}

/** The research tables of the earlier history, deleted with the research
 * schema in M4 (plan `01` A2, `02` W1.1). After the M8a squash no migration
 * creates them (plan `01` D5). */
const RESEARCH_TABLES = new Set([
  "collapsed_groups",
  "collapsed_places",
  "embed_assets",
  "feed_items",
  "folders",
  "followup_queue",
  "highlights",
  "image_refs",
  "interface_drafts",
  "node_messages",
  "node_summaries",
  "nodes",
  "notifications",
  "research_drafts",
  "research_images",
  "response_snapshots",
  "run_attempts",
  "run_queue",
  "run_turns",
  "tree_folder_membership",
  "tree_invites",
  "tree_member_removals",
  "tree_members",
  "tree_subscriptions",
  "tree_views",
  "trees",
  "tweet_cache",
  "widget_revisions",
  "widget_state",
  "workspaces",
]);

test("a fresh database migrates through 0000_initial.sql alone and holds no research table", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-migrate-"));
  const path = join(directory, "session.db");
  try {
    const db = openDatabase(path);
    const applied = db.$client.prepare(`SELECT hash FROM __drizzle_migrations`).all() as {
      hash: string;
    }[];
    t.is(applied.length, 1, "one migration applied");
    const tables = db.$client
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    const names = tables.map((row) => row.name);
    // The whole set, so a table the schema no longer declares is caught too.
    t.deepEqual(names, [
      "api_keys",
      "backfills",
      "change_log",
      "invites",
      "log_epochs",
      "oauth_states",
      "records",
      "registry",
      "run_live",
      "run_resumes",
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
      "usage_billing",
      "usage_events",
      "user_limits",
      "user_preferences",
      "users",
    ]);
    t.deepEqual(
      names.filter((name) => RESEARCH_TABLES.has(name) || name === "invites_legacy"),
      [],
    );
    t.is(tableRowCount(db, "users"), 0);
    closeDatabase(db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the schema declares no research table", (t) => {
  const declared = Object.values(schema).flatMap((value) =>
    is(value, SQLiteTable) ? [getTableName(value)] : [],
  );
  t.true(declared.length > 0);
  t.deepEqual(
    declared.filter((name) => RESEARCH_TABLES.has(name)),
    [],
  );
});

test("the history is the one initial migration", (t) => {
  // M8a squashed 0000_initial and 0003-0007 into one 0000_initial.sql
  // generated from the schema (plan `01` D5). A database made by the earlier
  // history is not upgraded: it answers UnknownMigrationError at boot and is
  // replaced (runbooks/reset-database.md). Later schema changes add numbered
  // migrations after this one.
  const { entries } = readJournal();
  t.deepEqual(
    entries.map((entry) => entry.tag),
    ["0000_initial"],
  );
  t.deepEqual(
    readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .sort(),
    ["0000_initial.sql"],
  );
  t.deepEqual(readdirSync(join(MIGRATIONS_FOLDER, "meta")).sort(), [
    "0000_snapshot.json",
    "_journal.json",
  ]);
});

test("journal entries ascend: idx and when strictly increase together", (t) => {
  const { entries } = readJournal();
  t.true(entries.length > 0);
  entries.forEach((entry, index) => {
    t.true(entry.tag.startsWith(String(entry.idx).padStart(4, "0")), `${entry.tag} matches idx`);
    const previous = entries[index - 1];
    if (!previous) return;
    t.true(entry.idx > previous.idx, `${entry.tag}: idx after ${previous.tag}`);
    // Drizzle's migrator skips an entry dated before the last applied one.
    t.true(entry.when > previous.when, `${entry.tag}: when after ${previous.tag}`);
  });
});

test("0000_initial creates the records indexes of 01 D1 and the change log's, and seeds the server head", (t) => {
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

test("every migration has a snapshot, chained, and the latest one holds the schema", async (t) => {
  const { entries } = readJournal();
  const snapshots = entries.map(
    (entry) =>
      JSON.parse(
        readFileSync(
          join(MIGRATIONS_FOLDER, "meta", `${entry.tag.slice(0, 4)}_snapshot.json`),
          "utf8",
        ),
      ) as Snapshot,
  );
  for (let index = 1; index < snapshots.length; index += 1) {
    t.is(snapshots[index]?.prevId, snapshots[index - 1]?.id, `${entries[index]?.tag} chains`);
  }
  // What `drizzle-kit generate` would emit now: nothing.
  const latest = snapshots.at(-1);
  if (!latest) throw new Error("no snapshot");
  const kit = (await import("drizzle-kit/api")) as unknown as DrizzleKitApi;
  const statements = await kit.generateSQLiteMigration(
    latest,
    await kit.generateSQLiteDrizzleJson(schema, latest.id),
  );
  t.deepEqual(statements, []);
});

test("a migration dated before one already applied fails startup", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-unapplied-"));
  const folder = join(directory, "migrations");
  const path = join(directory, "session.db");
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journal = readJournal(folder);
    const first = journal.entries[0] as JournalEntry;
    const writeJournal = () =>
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
    // A database that applied the initial migration and a later one.
    journal.entries.push({ ...first, idx: 2, when: first.when + 2, tag: "0002_next" });
    writeJournal();
    writeFileSync(join(folder, "0002_next.sql"), "CREATE TABLE `next_table` (`id` text);");
    closeDatabase(openDatabase(path, { migrationsFolder: folder }));
    // Another branch's migration merged later, but dated before the last one
    // applied: drizzle's migrator would skip it.
    journal.entries.splice(1, 0, { ...first, idx: 1, when: first.when + 1, tag: "0001_late" });
    writeJournal();
    writeFileSync(join(folder, "0001_late.sql"), "CREATE TABLE `late_table` (`id` text);");

    const client = new SqliteDatabase(path);
    t.deepEqual(unappliedMigrations(client, folder), ["0001_late"]);
    client.close();
    const error = t.throws(() => openDatabase(path, { migrationsFolder: folder }), {
      instanceOf: UnappliedMigrationError,
    });
    t.regex(error?.message ?? "", /0001_late/);
    // The shipped history leaves nothing unapplied.
    const db = openDatabase(join(directory, "fresh.db"));
    t.deepEqual(unappliedMigrations(db.$client), []);
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
