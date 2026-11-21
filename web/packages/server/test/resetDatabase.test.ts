// The database reset (`runbooks/reset-database.md`): it refuses while
// another connection has the database open or a server's heartbeat is
// fresh, as the account-deletion job does; it deletes the database, its WAL,
// Litestream's local state and the volume's data directories otherwise, and
// the next open builds an empty database from the one initial migration.

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HEARTBEAT_STALE_MS, clearHeartbeat, openDatabase, writeHeartbeat } from "@session/db";
import test, { type ExecutionContext } from "ava";
import SqliteDatabase from "better-sqlite3";

import { ResetRefusedError, resetDatabase } from "../src/ops/resetDatabase.js";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(PACKAGE, "scripts", "reset-database.ts");

/** The script under tsx, from `cwd`, with `env` over this process's
 * environment minus `SESSION_DATA_DIR`. */
function script(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (!options.env || !("SESSION_DATA_DIR" in options.env)) delete env["SESSION_DATA_DIR"];
  return run(process.execPath, ["--import", import.meta.resolve("tsx"), SCRIPT, ...args], {
    cwd: options.cwd ?? PACKAGE,
    env: { ...env, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json") },
  });
}

type Failed = { code?: number; stdout?: string; stderr?: string };

/** A data directory as a stopped server leaves it, with the files the reset
 * deletes and the ones it keeps. The database stays open and is returned,
 * so a test decides whether a heartbeat is left in it and when to close it. */
function dataDir(t: ExecutionContext) {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "session.db"));
  t.teardown(() => {
    if (db.$client.open) db.$client.close();
  });
  for (const sub of ["documents/U1", "embeds", "tmp", ".session.db-litestream"])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "documents", "U1", "abc"), "x");
  writeFileSync(join(dir, "embeds", "def"), "x");
  writeFileSync(join(dir, "tmp", "documents-backup.stamp"), "");
  writeFileSync(join(dir, "tmp", "vertex-credentials.json"), "{}");
  writeFileSync(join(dir, ".session.db-litestream", "ltx"), "x");
  return { dir, db };
}

/** A directory whose `session.db` is a database of an older build: no
 * `server_meta`, so no heartbeat. */
function oldDatabase(t: ExecutionContext) {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-old-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const old = new SqliteDatabase(join(dir, "session.db"));
  old.pragma("journal_mode = WAL");
  old.exec("CREATE TABLE nodes (id text)");
  old.close();
  return dir;
}

function untouched(t: ExecutionContext, dir: string) {
  t.true(existsSync(join(dir, "session.db")));
  t.true(existsSync(join(dir, "documents", "U1", "abc")));
  t.true(existsSync(join(dir, "embeds", "def")));
}

test("R1: refuses while another connection has the database open, with no heartbeat, and deletes nothing", (t) => {
  // a server between openDatabase and its first heartbeat, or a build
  // without the heartbeat, or Litestream
  const { dir } = dataDir(t);
  const error = t.throws(() => resetDatabase({ dataDir: dir, apply: true }), {
    instanceOf: ResetRefusedError,
  });
  t.regex(error?.message ?? "", /needs the server stopped: another process has the database open/);
  untouched(t, dir);
});

test("refuses while a server's heartbeat is fresh and deletes nothing", (t) => {
  const { dir, db } = dataDir(t);
  const at = Date.now();
  writeHeartbeat(db, at);
  db.$client.close();
  const error = t.throws(() => resetDatabase({ dataDir: dir, apply: true, now: at + 1000 }), {
    instanceOf: ResetRefusedError,
  });
  t.regex(
    error?.message ?? "",
    /needs the server stopped: a server \(pid \d+\) wrote its heartbeat 1 s ago/,
  );
  untouched(t, dir);
});

test("R7: a heartbeat dated ahead of this machine's clock is refused as such", (t) => {
  const { dir, db } = dataDir(t);
  const at = Date.now();
  writeHeartbeat(db, at + 120_000);
  db.$client.close();
  t.throws(() => resetDatabase({ dataDir: dir, apply: true, now: at }), {
    instanceOf: ResetRefusedError,
    message: /a heartbeat dated 120 s ahead of this machine's clock/,
  });
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
  t.true(report.locked);
  t.false(existsSync(join(dir, "session.db")));
});

test("R18: a heartbeat 90 s old counts as stopped when no time is given", (t) => {
  const { dir, db } = dataDir(t);
  writeHeartbeat(db, Date.now() - HEARTBEAT_STALE_MS);
  db.$client.close();
  t.is(resetDatabase({ dataDir: dir, apply: false }).stopped, "heartbeat");
});

test("after a clean shutdown it deletes the database and the data, and keeps the credential", (t) => {
  const { dir, db } = dataDir(t);
  writeHeartbeat(db, Date.now());
  clearHeartbeat(db);
  db.$client.close();
  // the shutdown's close removed the WAL and shared-memory files
  const before = readdirSync(dir).sort();
  t.false(before.includes("session.db-wal"));
  const listed = resetDatabase({ dataDir: dir, apply: false });
  t.false(listed.applied);
  t.is(listed.stopped, "heartbeat");
  t.true(listed.locked);
  // R5: the listing deletes nothing and leaves no -wal or -shm of its own
  t.deepEqual(readdirSync(dir).sort(), before, "a listing changes no file");

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
  const dir = oldDatabase(t);
  const error = t.throws(() => resetDatabase({ dataDir: dir, apply: true }), {
    instanceOf: ResetRefusedError,
  });
  t.regex(error?.message ?? "", /no server_meta table/);
  t.true(existsSync(join(dir, "session.db")));
  const report = resetDatabase({ dataDir: dir, apply: true, assumeStopped: true });
  t.is(report.stopped, "assumed");
  t.true(report.locked);
  t.false(existsSync(join(dir, "session.db")));
});

test("R12: --assume-stopped still refuses on a fresh heartbeat, and while another connection has the file open", (t) => {
  const { dir, db } = dataDir(t);
  writeHeartbeat(db, Date.now());
  db.$client.close();
  t.throws(() => resetDatabase({ dataDir: dir, apply: true, assumeStopped: true }), {
    instanceOf: ResetRefusedError,
    message: /wrote its heartbeat/,
  });
  untouched(t, dir);

  const old = oldDatabase(t);
  const holder = new SqliteDatabase(join(old, "session.db"));
  holder.prepare("SELECT count(*) FROM nodes").get();
  t.throws(() => resetDatabase({ dataDir: old, apply: true, assumeStopped: true }), {
    instanceOf: ResetRefusedError,
    message: /another process has the database open/,
  });
  t.true(existsSync(join(old, "session.db")));
  holder.close();
});

test("R2: a session.db that is not a SQLite database needs --assume-stopped", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-garbage-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "session.db"), "not a database ".repeat(400));
  mkdirSync(join(dir, "documents"));
  writeFileSync(join(dir, "documents", "a"), "x");
  const error = t.throws(() => resetDatabase({ dataDir: dir, apply: true }), {
    instanceOf: ResetRefusedError,
  });
  t.regex(error?.message ?? "", /cannot be read as a SQLite database \(file is not a database\)/);
  t.regex(error?.message ?? "", /could not lock it/);
  t.regex(error?.message ?? "", /--assume-stopped/);
  t.true(existsSync(join(dir, "documents", "a")));
  const report = resetDatabase({ dataDir: dir, apply: true, assumeStopped: true });
  t.like(report, { stopped: "assumed", locked: false, unreadable: "file is not a database" });
  t.deepEqual(readdirSync(dir), ["documents"]);
  t.deepEqual(readdirSync(join(dir, "documents")), []);
});

test("R3: with no database it refuses to delete without --no-database, and lists without --yes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-empty-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "embeds"));
  mkdirSync(join(dir, "documents"));
  writeFileSync(join(dir, "documents", "a"), "x");
  const listed = resetDatabase({ dataDir: dir, apply: false });
  t.like(listed, { stopped: "no database", applied: false, locked: false });
  t.deepEqual(listed.paths.sort(), [join(dir, "documents", "a"), join(dir, "embeds")]);
  t.throws(() => resetDatabase({ dataDir: dir, apply: true }), {
    instanceOf: ResetRefusedError,
    message: /There is no .*session\.db.*--yes --no-database/,
  });
  t.true(existsSync(join(dir, "documents", "a")));
  const report = resetDatabase({ dataDir: dir, apply: true, noDatabase: true });
  t.is(report.stopped, "no database");
  t.deepEqual(readdirSync(dir), ["documents"]);
  t.deepEqual(readdirSync(join(dir, "documents")), []);
});

test("R4: a symlinked documents, embeds or session.db is refused and its target kept", (t) => {
  for (const name of ["documents", "embeds", "session.db"]) {
    const { dir, db } = dataDir(t);
    db.$client.close();
    const elsewhere = mkdtempSync(join(tmpdir(), "session-reset-target-"));
    t.teardown(() => rmSync(elsewhere, { recursive: true, force: true }));
    writeFileSync(join(elsewhere, "keep"), "x");
    rmSync(join(dir, name), { recursive: true, force: true });
    symlinkSync(name === "session.db" ? join(elsewhere, "keep") : elsewhere, join(dir, name));
    t.throws(() => resetDatabase({ dataDir: dir, apply: true }), {
      instanceOf: ResetRefusedError,
      message: new RegExp(`${name.replace(".", "\\.")} is a symbolic link`),
    });
    t.true(existsSync(join(elsewhere, "keep")), name);
  }
});

test("the script exits 1 while the heartbeat is fresh and deletes with --yes", async (t) => {
  const { dir, db } = dataDir(t);
  writeHeartbeat(db, Date.now());
  db.$client.close();
  const refused = (await t.throwsAsync(script(["--data-dir", dir, "--yes"]))) as Failed;
  t.is(refused.code, 1);
  t.regex(refused.stderr ?? "", /needs the server stopped/);
  t.true(existsSync(join(dir, "session.db")));
  const held = new SqliteDatabase(join(dir, "session.db"));
  clearHeartbeat(held);
  held.close();
  const listed = await script(["--data-dir", dir]);
  t.regex(listed.stdout, /would delete {2}.*session\.db/);
  t.regex(listed.stdout, /run again with --yes/);
  t.true(existsSync(join(dir, "session.db")));
  const done = await script(["--data-dir", dir, "--yes"]);
  t.regex(done.stdout, /^no server heartbeat in the last 90 s$/m);
  t.regex(
    done.stdout,
    /^the reset held an exclusive lock on .*session\.db: no other process had it open$/m,
  );
  t.regex(done.stdout, /deleted {2}.*session\.db$/m);
  t.false(existsSync(join(dir, "session.db")));
});

test("C2a: the script with --yes on a database without server_meta exits 1 and keeps it", async (t) => {
  const dir = oldDatabase(t);
  const refused = (await t.throwsAsync(script(["--data-dir", dir, "--yes"]))) as Failed;
  t.is(refused.code, 1);
  t.regex(refused.stderr ?? "", /no server_meta table/);
  t.true(existsSync(join(dir, "session.db")));
});

test("C2b: the script with --yes --assume-stopped deletes it and says the server is taken as stopped", async (t) => {
  const dir = oldDatabase(t);
  const done = await script(["--data-dir", dir, "--yes", "--assume-stopped"]);
  t.regex(done.stdout, /no server_meta table: the server is taken as stopped \(--assume-stopped\)/);
  t.false(existsSync(join(dir, "session.db")));
});

test("C4: --data-dir wins over SESSION_DATA_DIR", async (t) => {
  const { dir, db } = dataDir(t);
  db.$client.close();
  const other = dataDir(t);
  other.db.$client.close();
  await script(["--data-dir", dir, "--yes"], { env: { SESSION_DATA_DIR: other.dir } });
  t.false(existsSync(join(dir, "session.db")));
  untouched(t, other.dir);
});

test("R3: an empty SESSION_DATA_DIR is unset, not the current directory", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "session-reset-cwd-"));
  t.teardown(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "documents"));
  writeFileSync(join(cwd, "documents", "keep"), "x");
  const done = await script(["--yes", "--no-database"], { cwd, env: { SESSION_DATA_DIR: "" } });
  t.regex(done.stdout, new RegExp(`no database at ${join(cwd, ".data", "session.db")}`));
  t.true(existsSync(join(cwd, "documents", "keep")));
});

test("C6: an error that is not a refusal exits 3", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-reset-odd-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  // a directory where the database file should be: SQLite cannot open it
  mkdirSync(join(dir, "session.db"));
  const failed = (await t.throwsAsync(script(["--data-dir", dir, "--yes"]))) as Failed;
  t.is(failed.code, 3);
  t.true(existsSync(join(dir, "session.db")));
});
