import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import test from "ava";
import SqliteDatabase from "better-sqlite3";

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

/** The tables `0000_initial.sql` still creates that the schema no longer
 * declares: M8a's squash drops them (plan `01` D5). */
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
        "run_resumes",
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
  // plan's `0001_spaces`, numbered after the ones that landed first),
  // `0006_runs` (M5a), `0007_weekly_tokens` (M5b's allowance override).
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  t.deepEqual(
    journal.entries.map((entry) => entry.tag),
    [
      "0000_initial",
      "0003_api_keys",
      "0004_accounts",
      "0005_spaces",
      "0006_runs",
      "0007_weekly_tokens",
    ],
  );
  t.deepEqual(
    readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .sort(),
    [
      "0000_initial.sql",
      "0003_api_keys.sql",
      "0004_accounts.sql",
      "0005_spaces.sql",
      "0006_runs.sql",
      "0007_weekly_tokens.sql",
    ],
  );
});

test("journal entries ascend: idx and when strictly increase together", (t) => {
  const { entries } = readJournal();
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as JournalEntry;
    const entry = entries[index] as JournalEntry;
    t.true(entry.idx > previous.idx, `${entry.tag}: idx after ${previous.tag}`);
    // Drizzle's migrator skips an entry dated before the last applied one.
    t.true(entry.when > previous.when, `${entry.tag}: when after ${previous.tag}`);
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
  // What `drizzle-kit generate` would emit now: nothing for the declared
  // tables (they are in the latest snapshot), only the drops of the research
  // tables the squash removes.
  const latest = snapshots.at(-1);
  if (!latest) throw new Error("no snapshot");
  const kit = (await import("drizzle-kit/api")) as unknown as DrizzleKitApi;
  const statements = await kit.generateSQLiteMigration(
    latest,
    await kit.generateSQLiteDrizzleJson(schema, latest.id),
  );
  const unexpected = statements.filter((statement) => {
    const dropped = /^DROP TABLE `([a-z_]+)`;$/.exec(statement.trim())?.[1];
    return dropped === undefined || !RESEARCH_TABLES.has(dropped);
  });
  t.deepEqual(unexpected, []);
});

test("a migration dated before one already applied fails startup", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-unapplied-"));
  const folder = join(directory, "migrations");
  const path = join(directory, "session.db");
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    closeDatabase(openDatabase(path, { migrationsFolder: folder }));
    // Another branch's migration merged later, but dated before the last one
    // applied: drizzle's migrator would skip it.
    const journal = readJournal(folder);
    const first = journal.entries[0] as JournalEntry;
    journal.entries.splice(1, 0, { ...first, idx: 1, when: first.when + 1, tag: "0001_late" });
    writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
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
