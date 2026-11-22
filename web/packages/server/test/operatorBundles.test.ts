// The operator bundles of the runtime image (`web/Dockerfile`): `admin.mjs`
// and `reset-database.mjs`, built with the esbuild commands of this
// package's `build` script and run with plain node from the image's layout,
// `packages/server/dist/` beside `packages/db/migrations`. The only test
// that executes them as the image does (`runbooks/launch.md` §6 step 6,
// `reset-database.md`).

import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { closeDatabase, openDatabase, users } from "@session/db";
import test from "ava";
import SqliteDatabase from "better-sqlite3";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(PACKAGE, "..", "..");

/** The image's layout under a temp directory. */
const root = mkdtempSync(join(tmpdir(), "session-bundles-"));
const dist = join(root, "packages", "server", "dist");

test.before(async () => {
  mkdirSync(dist, { recursive: true });
  cpSync(join(WEB, "packages", "db", "migrations"), join(root, "packages", "db", "migrations"), {
    recursive: true,
  });
  // the production `node_modules` of the image, here the workspace's
  symlinkSync(join(WEB, "node_modules"), join(root, "node_modules"));
  const build = (
    JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      scripts: { build: string };
    }
  ).scripts.build;
  const esbuild = join(WEB, "node_modules", "esbuild", "bin", "esbuild");
  for (const name of ["admin.mjs", "reset-database.mjs"]) {
    const command = build.split(" && ").find((c) => c.endsWith(`--outfile=dist/${name}`));
    if (!command) throw new Error(`no esbuild command for ${name} in the build script`);
    const args = command
      .split(" ")
      .slice(1)
      .map((a) => (a === `--outfile=dist/${name}` ? `--outfile=${join(dist, name)}` : a));
    // a native binary or a node script with a `#!` line, by platform
    await run(esbuild, [...args, "--log-level=warning"], { cwd: PACKAGE });
  }
});

test.after.always(() => rmSync(root, { recursive: true, force: true }));

const bundle = (name: string, args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [join(dist, name), ...args], {
    cwd: root,
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });

type Failed = { code?: number; stdout?: string; stderr?: string };

test("A1: the image's admin.mjs, beside the migrations, prints a root invite", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "session-bundles-data-"));
  t.teardown(() => rmSync(data, { recursive: true, force: true }));
  const out = await bundle("admin.mjs", ["--invite"], { SESSION_DATA_DIR: data });
  t.regex(out.stdout, /^SESS-[A-Z0-9]{4}-[A-Z0-9]{2}$/m);
  const db = new SqliteDatabase(join(data, "session.db"), { readonly: true });
  t.deepEqual(db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(), { n: 1 });
  t.deepEqual(db.prepare("SELECT count(*) AS n FROM invites").get(), { n: 1 });
  db.close();
});

test("I2: the image's admin.mjs gives a member more invites with --grant-invites", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "session-bundles-data-"));
  t.teardown(() => rmSync(data, { recursive: true, force: true }));
  const db = openDatabase(join(data, "session.db"));
  users.createActive(
    db,
    { provider: "github", providerUserId: "grant-1", login: "mira", name: "Mira" },
    { handle: "mira_k", displayName: "Mira" },
  );
  closeDatabase(db);
  const out = await bundle("admin.mjs", ["--grant-invites", "mira_k", "2"], {
    SESSION_DATA_DIR: data,
    SESSION_INVITES_PER_MEMBER: "4",
  });
  t.is(out.stdout, "Gave @mira_k 2 more invites. @mira_k: 6 of 6 invites left (0 used)\n");
  const file = new SqliteDatabase(join(data, "session.db"), { readonly: true });
  t.deepEqual(file.prepare("SELECT extra_invites AS extra FROM user_limits").all(), [{ extra: 2 }]);
  file.close();
  const failed = (await t.throwsAsync(
    bundle("admin.mjs", ["--grant-invites", "mira_k", "101"], { SESSION_DATA_DIR: data }),
  )) as Failed;
  t.is(failed.code, 1);
  t.regex(failed.stderr ?? "", /whole number from 1 to 100/);
});

test("A1: the image's reset-database.mjs runs on an empty data directory", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "session-bundles-data-"));
  t.teardown(() => rmSync(data, { recursive: true, force: true }));
  const out = await bundle("reset-database.mjs", ["--data-dir", data]);
  t.regex(out.stdout, new RegExp(`^no database at ${join(data, "session.db")}$`, "m"));
  t.regex(out.stdout, /^nothing to delete in /m);
});

test("A3: the image's admin.mjs refuses a database with an unrecognized migration", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "session-bundles-data-"));
  t.teardown(() => rmSync(data, { recursive: true, force: true }));
  const path = join(data, "session.db");
  closeDatabase(openDatabase(path));
  const c = new SqliteDatabase(path);
  c.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
    "f".repeat(64),
    Date.now() + 1000,
  );
  c.close();
  const failed = (await t.throwsAsync(
    bundle("admin.mjs", ["--invite"], { SESSION_DATA_DIR: data }),
  )) as Failed;
  t.is(failed.code, 1);
  t.regex(failed.stderr ?? "", /unrecognized migration/);
  t.notRegex(failed.stderr ?? "", /^\s+at /m, "one line, no stack trace");
  const db = new SqliteDatabase(path, { readonly: true });
  t.deepEqual(db.prepare("SELECT count(*) AS n FROM invites").get(), { n: 0 });
  db.close();
});

test("R9: neither bundle starts with a #! line naming tsx", (t) => {
  for (const name of ["admin.mjs", "reset-database.mjs"]) {
    const first = readFileSync(join(dist, name), "utf8").split("\n")[0] ?? "";
    t.false(first.startsWith("#!") && first.includes("tsx"), `${name}: ${first}`);
  }
});
