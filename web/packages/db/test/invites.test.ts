// Account invites, handles, waiting accounts and the operator commands
// (plan `04` §3.1 acceptance, `05` M6 exit criteria).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

import { parseInviteCode } from "@session/shared";
import test from "ava";
import type SqliteDatabase from "better-sqlite3";

import {
  accountInvites,
  accounts,
  auth,
  closeDatabase,
  openDatabase,
  users,
  writeHeartbeat,
} from "../src/index.js";
import type { SessionDatabase } from "../src/index.js";

import { addActiveUser, addWaitingUser, createFixture } from "./helpers.js";

const run = promisify(execFile);

/** Stands in for the server's AES-GCM: anything that is not the code. */
const encrypt = (code: string) => `enc:${Buffer.from(code).toString("base64")}`;
const decrypt = (value: string) => Buffer.from(value.slice(4), "base64").toString("utf8");

function invite(db: SessionDatabase, createdBy: string) {
  const made = accountInvites.create(db, { createdBy, encrypt });
  if (!made.ok) throw new Error("invite limit");
  return made;
}

function redeem(db: SessionDatabase, code: string, handle: string, provider: "github" | "x" = "x") {
  const waiting = addWaitingUser(db, { provider });
  t_assertOpen(accountInvites.setPendingInvite(db, waiting.id, code));
  return accountInvites.activate(db, { userId: waiting.id, handle, displayName: handle });
}

function t_assertOpen(check: { status: string }) {
  if (check.status !== "open") throw new Error(`expected an open invite, got ${check.status}`);
}

/** Every text value in every table of the database. */
function allText(client: SqliteDatabase.Database): string[] {
  const tables = client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const values: string[] = [];
  for (const { name } of tables) {
    for (const row of client.prepare(`SELECT * FROM "${name}"`).all() as Record<
      string,
      unknown
    >[]) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") values.push(value);
      }
    }
  }
  return values;
}

test("a code is found by its hash, in any form a person pastes", (t) => {
  const { db, userId } = createFixture(t);
  const made = invite(db, userId);
  t.regex(made.code, /^SESS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/);
  const row = db.$client
    .prepare(`SELECT code_hash AS hash, code_enc AS enc FROM invites WHERE id = ?`)
    .get(made.id) as { hash: string; enc: string };
  t.is(row.hash, accountInvites.hashInviteCode(made.code));
  t.is(decrypt(row.enc), made.code);
  for (const typed of [
    made.code,
    made.code.toLowerCase(),
    made.code.replace(/-/g, " "),
    `https://session.dev/i#${made.code.toLowerCase()}`,
    `https://session.dev/i/${made.code}/`,
  ]) {
    t.is(parseInviteCode(typed), made.code, typed);
    const check = accountInvites.checkCode(db, typed);
    t.is(check.status, "open", typed);
  }
  t.deepEqual(accountInvites.checkCode(db, "SESS-ZZZZ-ZZ"), { status: "unusable" });
  t.deepEqual(accountInvites.checkCode(db, "not a code"), { status: "unusable" });
});

test("no column and no byte of the file holds a plain code", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-invites-plain-"));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  const db = openDatabase(path);
  const inviter = addActiveUser(db, "plain.inviter");
  const open = invite(db, inviter.id);
  const used = invite(db, inviter.id);
  t.true(redeem(db, used.code, "plain.user").ok);
  const texts = allText(db.$client);
  for (const code of [open.code, used.code]) {
    t.false(
      texts.some((value) => value.includes(code)),
      code,
    );
  }
  const hashes = db.$client
    .prepare(`SELECT code_hash AS hash FROM invites WHERE created_by = ? ORDER BY created_at`)
    .all(inviter.id) as { hash: string }[];
  t.deepEqual(
    hashes.map((row) => row.hash),
    [accountInvites.hashInviteCode(open.code), accountInvites.hashInviteCode(used.code)],
  );
  // Nothing on disk either, once the WAL is folded in and free pages dropped.
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  db.$client.exec("VACUUM");
  closeDatabase(db);
  const bytes = readFileSync(path).toString("latin1");
  t.false(bytes.includes(open.code));
  t.false(bytes.includes(used.code));
});

test("code_enc is null after use and after revoke; revoked and used codes are unusable", (t) => {
  const { db, userId } = createFixture(t);
  const used = invite(db, userId);
  const revoked = invite(db, userId);
  const result = redeem(db, used.code, "first.user");
  t.true(result.ok);
  t.true(accountInvites.revoke(db, userId, revoked.id));
  t.false(accountInvites.revoke(db, userId, revoked.id), "no restore, no second revoke");
  const encs = db.$client
    .prepare(`SELECT id, code_enc AS enc FROM invites WHERE id IN (?, ?)`)
    .all(used.id, revoked.id) as { enc: string | null }[];
  t.deepEqual(
    encs.map((row) => row.enc),
    [null, null],
  );
  t.deepEqual(accountInvites.checkCode(db, used.code), { status: "unusable" });
  t.deepEqual(accountInvites.checkCode(db, revoked.code), { status: "unusable" });
  // One answer for used, revoked and unknown, down to the bytes.
  t.is(
    JSON.stringify(accountInvites.checkCode(db, used.code)),
    JSON.stringify(accountInvites.checkCode(db, "SESS-2222-22")),
  );
  // The list shows states; codes only of open links.
  const links = accountInvites.listForCreator(db, userId);
  t.deepEqual(links.map((link) => link.state).sort(), ["revoked", "used"]);
  t.true(links.every((link) => link.codeEnc === null));
});

test("I2: a member has 3 invites in all; a used link spends one, an open one holds one, a revoked one gives it back", (t) => {
  const { db, userId } = createFixture(t);
  const refused = { ok: false, reason: "limit" };
  t.deepEqual(accountInvites.allowance(db, userId), {
    total: 3,
    used: 0,
    open: 0,
    left: 3,
    extra: 0,
  });
  const links = [invite(db, userId), invite(db, userId), invite(db, userId)];
  t.like(accountInvites.allowance(db, userId), { used: 0, open: 3, left: 0 });
  t.deepEqual(accountInvites.create(db, { createdBy: userId, encrypt }), refused);
  // Revoking an unused link gives its invite back.
  t.true(accountInvites.revoke(db, userId, links[0]?.id ?? ""));
  t.like(accountInvites.allowance(db, userId), { used: 0, open: 2, left: 1 });
  const fourth = invite(db, userId);
  // A used link stays spent: no invite comes back when it is used.
  t.true(redeem(db, links[1]?.code ?? "", "slot.user").ok);
  t.like(accountInvites.allowance(db, userId), { total: 3, used: 1, open: 2, left: 0 });
  t.deepEqual(accountInvites.create(db, { createdBy: userId, encrypt }), refused);
  // A used link cannot be revoked, so its invite never comes back.
  t.false(accountInvites.revoke(db, userId, links[1]?.id ?? ""));
  t.true(accountInvites.revoke(db, userId, fourth.id));
  t.like(accountInvites.allowance(db, userId), { used: 1, open: 1, left: 1 });
  t.true(accountInvites.create(db, { createdBy: userId, encrypt }).ok);
  t.like(accountInvites.allowance(db, userId), { used: 1, open: 2, left: 0 });
  // The setting is the total each member starts with.
  t.like(accountInvites.allowance(db, userId, 5), { total: 5, left: 2 });
  t.true(accountInvites.create(db, { createdBy: userId, perMember: 5, encrypt }).ok);
  // Site admins are not counted.
  for (let index = 0; index < 5; index += 1) {
    t.true(accountInvites.create(db, { createdBy: userId, exempt: true, encrypt }).ok);
  }
});

test("I2: extra invites a site admin gives raise the total; nothing else changes it", (t) => {
  const { db, userId } = createFixture(t);
  const other = addActiveUser(db, "other.one");
  for (let index = 0; index < 3; index += 1) invite(db, userId);
  t.like(accountInvites.allowance(db, userId), { total: 3, left: 0 });
  t.like(accountInvites.grant(db, userId, 2), { total: 5, used: 0, open: 3, left: 2, extra: 2 });
  t.like(accountInvites.grant(db, userId, 1), { total: 6, left: 3, extra: 3 });
  t.like(accountInvites.allowance(db, other.id), { total: 3, extra: 0 });
  for (let index = 0; index < 3; index += 1) invite(db, userId);
  t.deepEqual(accountInvites.create(db, { createdBy: userId, encrypt }), {
    ok: false,
    reason: "limit",
  });
});

/** Runs `parties` workers against the database at `path`, released at once. */
async function race(
  path: string,
  sides: { op: "activate" | "create"; userId: string; handle?: string }[],
): Promise<{ ok: boolean; reason: string | null }[]> {
  const barrier = new SharedArrayBuffer(4);
  return Promise.all(
    sides.map(
      (side) =>
        new Promise<{ ok: boolean; reason: string | null }>((resolve, reject) => {
          const worker = new Worker(new URL("./fixtures/race.worker.ts", import.meta.url), {
            workerData: { path, barrier, parties: sides.length, ...side },
            execArgv: ["--import=tsx"],
          });
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    ),
  );
}

test("an afterRedeem that throws makes activate rethrow, and the invite stays unredeemed", (t) => {
  const { db, userId } = createFixture(t);
  const made = invite(db, userId);
  const waiting = addWaitingUser(db);
  t_assertOpen(accountInvites.setPendingInvite(db, waiting.id, made.code));
  t.throws(
    () =>
      accountInvites.activate(db, {
        userId: waiting.id,
        handle: "late.comer",
        displayName: "Late",
        afterRedeem: () => {
          throw new Error("the notification failed");
        },
      }),
    { message: "the notification failed" },
  );
  t.like(users.findById(db, waiting.id), { status: "waiting", handle: null });
  t_assertOpen(accountInvites.checkCode(db, made.code));
  const row = db.$client.prepare("SELECT used_by AS by FROM invites WHERE id = ?").get(made.id) as {
    by: string | null;
  };
  t.is(row.by, null);
});

test("two concurrent redemptions of one code: one succeeds and one conflicts", async (t) => {
  const { db, directory, userId } = createFixture(t);
  const made = invite(db, userId);
  const first = addWaitingUser(db);
  const second = addWaitingUser(db);
  t_assertOpen(accountInvites.setPendingInvite(db, first.id, made.code));
  t_assertOpen(accountInvites.setPendingInvite(db, second.id, made.code));
  const outcomes = await race(join(directory, "session.db"), [
    { op: "activate", userId: first.id, handle: "racer.one" },
    { op: "activate", userId: second.id, handle: "racer.two" },
  ]);
  t.deepEqual(
    outcomes.map((outcome) => String(outcome.reason)).sort(),
    ["null", "unusable"],
    JSON.stringify(outcomes),
  );
  const rows = db.$client
    .prepare(
      `SELECT status, handle, invited_by AS by FROM users WHERE id IN (?, ?) ORDER BY status`,
    )
    .all(first.id, second.id) as { status: string; by: string | null }[];
  t.deepEqual(
    rows.map((row) => row.status),
    ["active", "waiting"],
  );
  t.is(rows[0]?.by, userId);
});

test("two concurrent creates with one invite left make one link, not two", async (t) => {
  const { db, directory, userId } = createFixture(t);
  invite(db, userId);
  invite(db, userId);
  const outcomes = await race(join(directory, "session.db"), [
    { op: "create", userId },
    { op: "create", userId },
  ]);
  t.deepEqual(
    outcomes.map((outcome) => String(outcome.reason)).sort(),
    ["limit", "null"],
    JSON.stringify(outcomes),
  );
  t.is(accountInvites.openCount(db, userId), 3);
});

test("handles are unique, checked, and never reused after account deletion", (t) => {
  const { db, userId } = createFixture(t);
  const one = invite(db, userId);
  const two = invite(db, userId);
  t.true(redeem(db, one.code, "ines.v").ok);
  const taken = redeem(db, two.code, "ines.v");
  t.deepEqual(taken, { ok: false, reason: "taken" });
  t.false(users.handleAvailable(db, "ines.v"));
  t.false(users.handleAvailable(db, "No Caps"));
  t.false(users.handleAvailable(db, "ab"));
  t.true(users.handleAvailable(db, "fresh_handle"));
  const owner = users.findByHandle(db, "ines.v");
  accounts.deleteAccount(db, owner?.id ?? "");
  t.false(users.handleAvailable(db, "ines.v"), "a deleted account keeps its handle");
  // The second account still has its pending invite and picks another handle.
  const waiting = db.$client
    .prepare(`SELECT id FROM users WHERE status = 'waiting' AND pending_invite_id IS NOT NULL`)
    .get() as { id: string };
  t.deepEqual(
    accountInvites.activate(db, { userId: waiting.id, handle: "ines.v", displayName: "Ines" }),
    { ok: false, reason: "taken" },
  );
  t.true(
    accountInvites.activate(db, { userId: waiting.id, handle: "ines.w", displayName: "Ines" }).ok,
  );
  t.throws(
    () => db.$client.prepare(`UPDATE users SET handle = 'ines.w' WHERE id = ?`).run(userId),
    {
      message: /UNIQUE/,
    },
  );
});

test("a deleted account's identity signs in again as a new waiting account", (t) => {
  const { db, userId } = createFixture(t);
  const made = invite(db, userId);
  const identity = { provider: "x" as const, providerUserId: "x-77", login: "rhea", email: "r@x" };
  const first = users.createWaiting(db, identity).user;
  t_assertOpen(accountInvites.setPendingInvite(db, first.id, made.code));
  t.true(accountInvites.activate(db, { userId: first.id, handle: "rhea", displayName: "Rhea" }).ok);
  const session = auth.createSession(db, first.id);
  const open = invite(db, first.id);

  const deleted = accounts.deleteAccount(db, first.id);
  t.is(deleted.sessions, 1);
  t.is(deleted.revokedInvites, 1);
  t.is(auth.readSession(db, session.token), null);
  t.deepEqual(accountInvites.checkCode(db, open.code), { status: "unusable" });
  const row = db.$client
    .prepare(
      `SELECT provider, provider_user_id AS pid, email, handle, deleted_at AS d FROM users WHERE id = ?`,
    )
    .get(first.id) as Record<string, unknown>;
  t.is(row["provider"], null);
  t.is(row["pid"], null);
  t.is(row["email"], null);
  t.is(row["handle"], "rhea");
  t.truthy(row["d"]);
  t.is(users.findById(db, first.id), null);
  t.is(users.findByIdentity(db, "x", "x-77"), null);

  const again = users.createWaiting(db, identity);
  t.true(again.created);
  t.not(again.user.id, first.id);
  t.is(again.user.status, "waiting");
  t.is(again.user.handle, null);
  // The tree keeps the deleted account as a node with no handle.
  const node = accountInvites.tree(db).find((entry) => entry.id === first.id);
  t.deepEqual(node && { handle: node.handle, invitedBy: node.invitedBy }, {
    handle: null,
    invitedBy: userId,
  });
});

test("an invite whose creator was deleted is not redeemed and stays unused", (t) => {
  const { db, userId } = createFixture(t);
  const made = invite(db, userId);
  const waiting = addWaitingUser(db);
  t_assertOpen(accountInvites.setPendingInvite(db, waiting.id, made.code));
  accounts.deleteAccount(db, userId);
  t.deepEqual(
    accountInvites.activate(db, { userId: waiting.id, handle: "orphan", displayName: "O" }),
    { ok: false, reason: "unusable" },
  );
  const row = db.$client.prepare(`SELECT used_by AS by FROM invites WHERE id = ?`).get(made.id);
  t.deepEqual(row, { by: null });
  t.is(users.findById(db, waiting.id)?.status, "waiting");
});

test("the waiting-account sweep deletes waiting accounts older than 90 days", (t) => {
  const { db, userId } = createFixture(t);
  const old = addWaitingUser(db);
  const recent = addWaitingUser(db);
  const at = Date.now();
  db.$client
    .prepare(`UPDATE users SET created_at = ? WHERE id IN (?, ?)`)
    .run(at - accounts.WAITING_ACCOUNT_TTL_MS - 1, old.id, userId);
  auth.createSession(db, old.id);
  t.is(accounts.sweepWaiting(db, at), 1);
  t.is(users.findById(db, old.id), null);
  t.truthy(users.findById(db, recent.id));
  t.truthy(users.findById(db, userId), "an active account of the same age stays");
  t.is(
    (
      db.$client.prepare(`SELECT count(*) AS n FROM sessions WHERE user_id = ?`).get(old.id) as {
        n: number;
      }
    ).n,
    0,
  );
});

test("waiting accounts are counted per IP key and day", (t) => {
  const { db } = createFixture(t);
  const at = Date.now();
  for (let index = 0; index < 5; index += 1) auth.recordSignupAttempt(db, "ip-a", "waiting", at);
  auth.recordSignupAttempt(db, "ip-a", "signed_in", at);
  auth.recordSignupAttempt(db, "ip-a", "waiting", at - 25 * 60 * 60 * 1000);
  t.is(auth.countSignupAttempts(db, "ip-a", at - 24 * 60 * 60 * 1000, "waiting"), 5);
});

test("the tree lists active accounts with their inviters and site admins as staff", (t) => {
  const { db, userId } = createFixture(t);
  db.$client.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).run(userId);
  const child = addActiveUser(db, "child.one", { invitedBy: userId });
  addWaitingUser(db);
  const nodes = accountInvites.tree(db);
  t.deepEqual(
    nodes.map((node) => [node.handle, node.invitedBy, node.staff]),
    [
      [users.findById(db, userId)?.handle ?? "", null, "admin"],
      [child.handle, userId, null],
    ],
  );
});

/** How `execFile` rejects when the command exits non-zero. */
type Failure = Error & { code?: number; stderr?: string };

/** `npm run db:admin -- …` against a database in `directory`. */
async function dbAdmin(directory: string, args: string[], env: Record<string, string> = {}) {
  // the setting only from `env`, never from the shell that runs the tests
  const inherited = { ...process.env };
  delete inherited["SESSION_INVITES_PER_MEMBER"];
  return run(process.execPath, ["--import=tsx", "bin/admin.ts", ...args], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...inherited,
      SESSION_DATA_DIR: directory,
      SESSION_PUBLIC_ORIGIN: "https://session.dev",
      ...env,
    },
  });
}

test("I2: db:admin --grant-invites gives a member more invites; a bad count or handle exits 1", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-grant-"));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, "session.db"));
  t.teardown(() => closeDatabase(db));
  const member = addActiveUser(db, "mira_k");
  invite(db, member.id);

  const granted = await dbAdmin(directory, ["--grant-invites", "@mira_k", "2"]);
  t.is(granted.stdout, "Gave @mira_k 2 more invites. @mira_k: 4 of 5 invites left (0 used)\n");
  t.like(accountInvites.allowance(db, member.id), { total: 5, extra: 2, left: 4 });
  // The total it prints follows SESSION_INVITES_PER_MEMBER, as the server's does.
  const again = await dbAdmin(directory, ["--grant-invites", "mira_k", "1"], {
    SESSION_INVITES_PER_MEMBER: "10",
  });
  t.is(again.stdout, "Gave @mira_k 1 more invite. @mira_k: 12 of 13 invites left (0 used)\n");

  for (const count of ["0", "101", "1.5", "two"]) {
    const failed = await t.throwsAsync<Failure>(
      dbAdmin(directory, ["--grant-invites", "mira_k", count]),
    );
    t.is(failed?.code, 1, count);
    t.regex(failed?.stderr ?? "", /whole number from 1 to 100/, count);
  }
  const missing = await t.throwsAsync<Failure>(dbAdmin(directory, ["--grant-invites", "mira_k"]));
  t.regex(missing?.stderr ?? "", /whole number from 1 to 100/);
  const unknown = await t.throwsAsync<Failure>(
    dbAdmin(directory, ["--grant-invites", "nobody.here", "2"]),
  );
  t.is(unknown?.code, 1);
  t.regex(unknown?.stderr ?? "", /No active account has the handle @nobody\.here\./);
  t.is(accountInvites.allowance(db, member.id).extra, 3);
});

test("db:admin prints a root invite and promotes by handle", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-admin-"));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  closeDatabase(openDatabase(join(directory, "session.db")));

  const printed = await dbAdmin(directory, ["--invite"]);
  const [code, link] = printed.stdout.trim().split("\n");
  t.regex(code ?? "", /^SESS-/);
  t.is(link, `https://session.dev/i#${code ?? ""}`);

  const db = openDatabase(join(directory, "session.db"));
  t.teardown(() => closeDatabase(db));
  const root = db.$client
    .prepare(`SELECT created_by AS by, code_enc AS enc FROM invites`)
    .get() as { by: string | null; enc: string | null };
  t.deepEqual(root, { by: null, enc: null });
  const check = accountInvites.checkCode(db, code ?? "");
  t.deepEqual(check, { status: "open", inviter: accountInvites.ROOT_INVITER });
  const redeemed = redeem(db, code ?? "", "first.admin", "github");
  t.true(redeemed.ok);
  t.is(redeemed.ok ? redeemed.invitedBy : "x", null);
  t.is(users.findByHandle(db, "first.admin")?.isAdmin, false);

  const promoted = await dbAdmin(directory, ["first.admin"]);
  t.regex(promoted.stdout, /@first\.admin is now a site admin/);
  t.is(users.findByHandle(db, "first.admin")?.isAdmin, true);
  // An admin is not counted against an invite total.
  const admin = users.findByHandle(db, "first.admin");
  t.is(admin?.isAdmin, true);

  const unknown = await t.throwsAsync(dbAdmin(directory, ["nobody.here"]));
  t.regex(
    (unknown as Error & { stderr?: string }).stderr ?? "",
    /No active account has the handle/,
  );
  // A waiting account has no handle, so it cannot be promoted either.
  const revoked = await dbAdmin(directory, ["first.admin", "--revoke"]);
  t.regex(revoked.stdout, /no longer a site admin/);
});

test("the deletion job deletes by handle and leaves the handle taken", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-delete-"));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  const before = openDatabase(path);
  const member = addActiveUser(before, "leaving.soon");
  // the job refuses while another connection has the file open
  closeDatabase(before);
  const output = await dbAdmin(directory, ["--delete", "leaving.soon"]);
  t.regex(output.stdout, /the handle stays reserved/);
  const db = openDatabase(path);
  t.is(users.findById(db, member.id), null);
  t.false(users.handleAvailable(db, "leaving.soon"));
  closeDatabase(db);
  await t.throwsAsync(dbAdmin(directory, ["--delete", "leaving.soon"]));
});

test("the deletion job exits 1 and changes nothing while a server's heartbeat is fresh", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-delete-"));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  const before = openDatabase(path);
  const member = addActiveUser(before, "still.here");
  writeHeartbeat(before, Date.now());
  closeDatabase(before);
  const refused = await t.throwsAsync(dbAdmin(directory, ["--delete", "still.here"]));
  t.like(refused, { code: 1 });
  t.regex(
    String((refused as { stderr?: unknown } | undefined)?.stderr),
    /needs the server stopped: a server \(pid \d+\) wrote its heartbeat/,
  );
  const db = openDatabase(path);
  t.teardown(() => closeDatabase(db));
  t.not(users.findById(db, member.id), null);
});

test("R1: the deletion job exits 1 and changes nothing while another connection has the database open", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-delete-"));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  // a server between openDatabase and its first heartbeat, or a build
  // without one: the file is open, no heartbeat row
  const db = openDatabase(join(directory, "session.db"));
  t.teardown(() => closeDatabase(db));
  const member = addActiveUser(db, "still.here");
  const refused = await t.throwsAsync(dbAdmin(directory, ["--delete", "still.here"]));
  t.like(refused, { code: 1 });
  t.regex(
    String((refused as { stderr?: unknown } | undefined)?.stderr),
    /needs the server stopped: another process has the database open/,
  );
  t.not(users.findById(db, member.id), null);
});
