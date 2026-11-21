// The privacy check of `04` P2 (`05` M6 exit criteria), run here against a
// temp database as the staging script runs it against the volume: after a
// removal the removed text is in neither the file nor its WAL, nor in any
// reader's snapshot or pull, nor in the author's notification. Before the
// removal each of those checks finds the text.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import test from "ava";
import SqliteDatabase from "better-sqlite3";

import { litestreamDir, privacyCheck } from "../src/ops/privacyCheck.js";

import { PUBLIC_ORIGIN, createHarness, type Harness } from "./helpers.js";
import { Person, channels, newId } from "./syncHttp.js";

const MARK = "PRIVACY-4c1e9b";
const READERS = ["the owner", "a member", "a non-member", "a signed-out reader", "the author"];

const run = promisify(execFile);

function inputOf(h: Harness, thread: string, text = MARK) {
  return { path: h.config.databasePath, thread, text, cursorKeys: h.config.sync.cursorKeys };
}

/** The checks of a report by name. */
const byName = (report: ReturnType<typeof privacyCheck>) =>
  new Map(report.checks.map((c) => [c.name, c]));

/** mona's post with the text, mel's reply with it and his save. */
async function removable(h: Harness, text = MARK) {
  const cast = await channels(h);
  const th = newId();
  await cast.mona.ok("threads.create", {
    id: th,
    space: cast.open,
    kind: "post",
    q: `A post ${text}`,
  });
  await cast.mel.ok("research.createPostFollowUp", {
    id: newId(),
    thread: th,
    t: `A reply ${text}`,
  });
  await cast.mel.ok("saved.set", { kind: "thread", id: th, on: true });
  return { ...cast, th };
}

test("after a removal the check passes for the file, the WAL and every reader; before it, it finds the text", async (t) => {
  const h = createHarness(t);
  const { olga, th } = await removable(h);
  const input = inputOf(h, th);
  const before = privacyCheck(input);
  t.false(before.ok);
  t.true(before.checks.some((c) => !c.ok && c.name.startsWith("the text is not in")));
  t.true(before.checks.some((c) => !c.ok && c.name === "the thread is removed"));

  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  const after = privacyCheck(input);
  t.deepEqual(
    after.checks.filter((c) => !c.ok),
    [],
  );
  t.true(after.ok);
  const names = after.checks.map((c) => c.name);
  for (const who of READERS) {
    t.true(names.includes(`${who}'s snapshot holds no removed text`), who);
    t.true(names.includes(`${who}'s pull from before the removal holds no removed text`), who);
    // an open channel: every reader's pull carries the thread's removal
    t.true(names.includes(`${who}'s pull from before the removal carries the removal`), who);
  }
  // the pulls were real pulls, not resyncs
  t.false(after.checks.some((c) => c.detail === "the pull answered resync"));
  t.true(names.includes("the removed notification holds no removed text"));
});

test("before the removal each reader's checks find the text, the author and the missing notification", async (t) => {
  const h = createHarness(t);
  const { th } = await removable(h);
  const checks = byName(privacyCheck(inputOf(h, th)));
  for (const who of READERS) {
    t.like(checks.get(`${who}'s snapshot holds no removed text`), { ok: false }, who);
    t.like(
      checks.get(`${who}'s pull from before the removal holds no removed text`),
      { ok: false },
      who,
    );
  }
  for (const who of ["the owner", "a member", "a non-member", "a signed-out reader"])
    t.like(checks.get(`${who}'s snapshot names no author of the removed thread`), { ok: false });
  t.like(checks.get("the author has the removed notification"), { ok: false });
});

test("a removal note that quotes the text fails the notification's check", async (t) => {
  const h = createHarness(t);
  const { olga, th } = await removable(h);
  await olga.ok("moderation.decide", {
    item: `p:${th}`,
    decision: "removed",
    note: `Quoting ${MARK}`,
  });
  const checks = byName(privacyCheck(inputOf(h, th)));
  t.like(checks.get("the author has the removed notification"), { ok: true });
  t.like(checks.get("the removed notification holds no removed text"), { ok: false });
});

test("a hidden thread is not removed", async (t) => {
  const h = createHarness(t);
  const { olga, th } = await removable(h);
  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "hidden" });
  const checks = byName(privacyCheck(inputOf(h, th)));
  t.like(checks.get("the thread is removed"), { ok: false, detail: "mod: hidden" });
});

test("text with quotes, a backslash and a line break is found as stored and as served", async (t) => {
  const h = createHarness(t);
  const text = 'He said "PRIVACY\\4c1e"\nthen left';
  const { olga, th } = await removable(h, text);
  const before = byName(privacyCheck(inputOf(h, th, text)));
  t.like(before.get(`the text is not in ${h.config.databasePath}`), { ok: false });
  t.like(before.get("a signed-out reader's snapshot holds no removed text"), { ok: false });
  t.like(before.get("a member's pull from before the removal holds no removed text"), {
    ok: false,
  });
  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  t.true(privacyCheck(inputOf(h, th, text)).ok);
});

test("text left only in the WAL fails the WAL's check", async (t) => {
  const h = createHarness(t);
  const { olga, th } = await removable(h);
  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  const path = h.config.databasePath;
  // a reader holds a snapshot from before the write, so no checkpoint copies
  // the write's frames into the file or resets the WAL
  const reader = new SqliteDatabase(path, { readonly: true });
  t.teardown(() => reader.close());
  reader.prepare("BEGIN").run();
  reader.prepare("SELECT count(*) FROM records").get();
  const writer = new SqliteDatabase(path);
  t.teardown(() => writer.close());
  writer.prepare("CREATE TABLE IF NOT EXISTS scratch (t TEXT)").run();
  writer.prepare("INSERT INTO scratch (t) VALUES (?)").run(`left ${MARK}`);
  const checks = byName(privacyCheck(inputOf(h, th)));
  t.like(checks.get(`the text is not in ${path}`), { ok: true });
  t.like(checks.get(`the text is not in ${path}-wal`), { ok: false });
  t.like(checks.get("the WAL was checkpointed"), { ok: false });
  reader.prepare("COMMIT").run();
});

test("text in Litestream's local state beside the database fails its check", async (t) => {
  const h = createHarness(t);
  const { olga, th } = await removable(h);
  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  const dir = join(litestreamDir(h.config.databasePath), "ltx", "0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0000000000000001-0000000000000001.ltx"), `frames ${MARK} frames`);
  const checks = byName(privacyCheck(inputOf(h, th)));
  const shadow = litestreamDir(h.config.databasePath);
  t.like(checks.get(`the text is not in ${shadow}`), { ok: false });
});

test("a pull that answers resync fails its check", async (t) => {
  const h = createHarness(t);
  const olga = new Person(h, h.addUser("olga"));
  const mona = new Person(h, h.addUser("mona"));
  const lounge = newId();
  await olga.ok("spaces.create", { id: lounge, name: "lounge" });
  await mona.ok("spaces.join", { space: lounge });
  const th = newId();
  await mona.ok("threads.create", { id: th, space: lounge, kind: "post", q: `A post ${MARK}` });
  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  // the channel's only other member joined after the removal: a cursor from
  // before it resyncs
  const ada = new Person(h, h.addUser("ada"));
  await ada.ok("spaces.join", { space: lounge });
  const checks = byName(privacyCheck(inputOf(h, th)));
  t.like(checks.get("a member's pull from before the removal holds no removed text"), {
    ok: false,
    detail: "the pull answered resync",
  });
});

test("the script exits 1 when a check fails and 0 when every check passes", async (t) => {
  const h = createHarness(t);
  const { olga, th } = await removable(h);
  const script = (args: string[]) =>
    run(process.execPath, ["--import=tsx", "scripts/privacy-check.ts", ...args], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        SESSION_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        SESSION_DATA_DIR: h.directory,
      },
    });
  const args = ["--db", h.config.databasePath, "--thread", th, "--text", MARK];
  const failed = await t.throwsAsync(script(args));
  t.like(failed, { code: 1 });
  t.regex(String((failed as { stdout?: unknown } | undefined)?.stdout), /privacy check FAILED/);
  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  const passed = await script(args);
  t.regex(passed.stdout, /privacy check passed/);
});
