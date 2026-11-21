// The database reset (`runbooks/reset-database.md`): it refuses while a
// server's heartbeat is fresh, as the account-deletion job does, deletes the
// database, its WAL, Litestream's local state and the volume's data
// directories otherwise, and the next open builds an empty database from
// the one initial migration.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { HEARTBEAT_STALE_MS, clearHeartbeat, openDatabase, writeHeartbeat } from "@session/db";
import test, { type ExecutionContext } from "ava";
import SqliteDatabase from "better-sqlite3";

import { ResetRefusedError, resetDatabase } from "../src/ops/resetDatabase.js";

const run = promisify(execFile);

/** A data directory as a stopped server leaves it, with the files the reset
 * deletes and the ones it keeps. The database stays open and is returned,
 * so a test decides whether a heartbeat is left in it. */
function dataDir(t: ExecutionContext) {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "session.db"));
  for (const sub of ["documents/U1", "embeds", "tmp", ".session.db-litestream"])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "documents", "U1", "abc"), "x");
  writeFileSync(join(dir, "embeds", "def"), "x");
  writeFileSync(join(dir, "tmp", "documents-backup.stamp"), "");
  writeFileSync(join(dir, "tmp", "vertex-credentials.json"), "{}");
  writeFileSync(join(dir, ".session.db-litestream", "ltx"), "x");
  return { dir, db };
}

test("refuses while a server's heartbeat is fresh and deletes nothing", (t) => {
  const { dir, db } = dataDir(t);
  const at = Date.now();
  writeHeartbeat(db, at);
  const error = t.throws(() => resetDatabase({ dataDir: dir, apply: true, now: at + 1000 }), {
    instanceOf: ResetRefusedError,
  });
  t.regex(error?.message ?? "", /needs the server stopped/);
  t.true(existsSync(join(dir, "session.db")));
  t.true(existsSync(join(dir, "documents", "U1", "abc")));
  t.true(existsSync(join(dir, "embeds", "def")));
  db.$client.close();
});

test("a killed server's heartbeat counts as stopped once it is stale", (t) => {
  const { dir, db } = dataDir(t);
  const at = Date.now();
  writeHeartbeat(db, at);
  db.$client.close();
  t.throws(() => resetDatabase({ dataDir: dir, apply: false, now: at + HEARTBEAT_STALE_MS - 1 }), {
    instanceOf: ResetRefusedError,
  });
  const report = resetDatabase({ dataDir: dir, apply: true, now: at + HEARTBEAT_STALE_MS });
  t.is(report.stopped, "heartbeat");
  t.false(existsSync(join(dir, "session.db")));
});

test("after a clean shutdown it deletes the database and the data, and keeps the credential", (t) => {
  const { dir, db } = dataDir(t);
  writeHeartbeat(db, Date.now());
  clearHeartbeat(db);
  // The WAL and shared-memory files are there while the connection is open.
  t.true(existsSync(join(dir, "session.db-wal")));
  const listed = resetDatabase({ dataDir: dir, apply: false });
  t.false(listed.applied);
  t.true(existsSync(join(dir, "session.db")), "a listing deletes nothing");
  db.$client.close();

  const report = resetDatabase({ dataDir: dir, apply: true });
  t.is(report.stopped, "heartbeat");
  t.true(report.applied);
  t.deepEqual(readdirSync(dir).sort(), ["documents", "tmp"]);
  t.deepEqual(readdirSync(join(dir, "documents")), []);
  t.deepEqual(readdirSync(join(dir, "tmp")), ["vertex-credentials.json"]);

  // The next boot builds an empty database from the one initial migration.
  const fresh = openDatabase(join(dir, "session.db"));
  t.deepEqual(fresh.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(), {
    n: 1,
  });
  t.deepEqual(fresh.$client.prepare("SELECT count(*) AS n FROM users").get(), { n: 0 });
  fresh.$client.close();
});

test("a database without server_meta needs --assume-stopped", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-old-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  // A database of an older build: no server_meta, so no heartbeat.
  const old = new SqliteDatabase(join(dir, "session.db"));
  old.exec("CREATE TABLE nodes (id text)");
  old.close();
  const error = t.throws(() => resetDatabase({ dataDir: dir, apply: true }), {
    instanceOf: ResetRefusedError,
  });
  t.regex(error?.message ?? "", /no server_meta table/);
  t.true(existsSync(join(dir, "session.db")));
  const report = resetDatabase({ dataDir: dir, apply: true, assumeStopped: true });
  t.is(report.stopped, "assumed");
  t.false(existsSync(join(dir, "session.db")));
});

test("with no database it deletes what is left of the data directories", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-empty-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "embeds"));
  const report = resetDatabase({ dataDir: dir, apply: true });
  t.is(report.stopped, "no database");
  t.deepEqual(report.paths, [join(dir, "embeds")]);
  t.deepEqual(readdirSync(dir), []);
});

test("the script exits 1 while the heartbeat is fresh and deletes with --yes", async (t) => {
  const { dir, db } = dataDir(t);
  writeHeartbeat(db, Date.now());
  const script = ["--import=tsx", "scripts/reset-database.ts", "--data-dir", dir];
  const refused = await t.throwsAsync(run(process.execPath, [...script, "--yes"]));
  t.is((refused as { code?: number }).code, 1);
  t.regex((refused as { stderr?: string }).stderr ?? "", /needs the server stopped/);
  t.true(existsSync(join(dir, "session.db")));
  clearHeartbeat(db);
  db.$client.close();
  const listed = await run(process.execPath, script);
  t.regex(listed.stdout, /would delete {2}.*session\.db/);
  t.regex(listed.stdout, /run again with --yes/);
  t.true(existsSync(join(dir, "session.db")));
  const done = await run(process.execPath, [...script, "--yes"]);
  t.regex(done.stdout, /^no server heartbeat in the last 90 s$/m);
  t.regex(done.stdout, /deleted {2}.*session\.db$/m);
  t.false(existsSync(join(dir, "session.db")));
});
