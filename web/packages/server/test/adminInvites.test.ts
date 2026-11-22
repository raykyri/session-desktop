// `admin.invites.lookup` and `admin.invites.grant` (plan `04` I2; `02`
// W8.2): a site admin reads a member's invites by handle and gives them
// more, in the `admin.models.*` bucket (`04` Z1).

import { accountInvites, accounts } from "@session/db";
import test from "ava";

import { createHarness } from "./helpers.js";

const NOT_FOUND = "No account with that handle.";

test("I2: admin.invites.lookup answers a member's invites; grant adds to the total", async (t) => {
  const harness = createHarness(t);
  const admin = harness.caller(harness.addUser("chief", { isAdmin: true }));
  const member = harness.addUser("mira_k");
  const own = harness.caller(member);
  const used = await own.accountInvites.create();
  await own.accountInvites.create();
  const joiner = harness.addWaitingUser("joiner");
  await harness.caller(joiner).accountInvites.redeem({ code: used.code });
  await harness.caller(joiner).account.create({ name: "Joiner", handle: "joiner" });

  t.deepEqual(await admin.admin.invites.lookup({ handle: "mira_k" }), {
    handle: "mira_k",
    displayName: "mira_k",
    total: 3,
    used: 1,
    open: 1,
    left: 1,
    extra: 0,
  });
  // "@mira_k" and other letter cases name the same account.
  t.like(await admin.admin.invites.lookup({ handle: " @Mira_K " }), { handle: "mira_k" });

  t.deepEqual(await admin.admin.invites.grant({ handle: "mira_k", count: 2 }), {
    handle: "mira_k",
    displayName: "mira_k",
    total: 5,
    used: 1,
    open: 1,
    left: 3,
    extra: 2,
  });
  t.like(await admin.admin.invites.grant({ handle: "@mira_k", count: 100 }), {
    total: 105,
    extra: 102,
  });
  t.deepEqual((await own.accountInvites.list()).allowance, { total: 105, used: 1, left: 103 });
});

test("I2: a member at 0 left can make a link once an admin gives them more", async (t) => {
  const harness = createHarness(t);
  const admin = harness.caller(harness.addUser("chief", { isAdmin: true }));
  const own = harness.caller(harness.addUser("mira_k"));
  for (let index = 0; index < 3; index += 1) await own.accountInvites.create();
  await t.throwsAsync(own.accountInvites.create(), { code: "PRECONDITION_FAILED" } as never);
  await admin.admin.invites.grant({ handle: "mira_k", count: 1 });
  await t.notThrowsAsync(own.accountInvites.create());
  await t.throwsAsync(own.accountInvites.create(), {
    message: "You have used your 4 invites. An admin can give you more.",
  });
});

test("I2: admin.invites.* refuses members, waiting accounts and signed-out callers", async (t) => {
  const harness = createHarness(t);
  const member = harness.addUser("mira_k");
  const callers = [
    { caller: harness.caller(member), code: "FORBIDDEN" },
    { caller: harness.caller(harness.addWaitingUser("waits")), code: "FORBIDDEN" },
    { caller: harness.caller(null), code: "UNAUTHORIZED" },
  ];
  for (const { caller, code } of callers) {
    await t.throwsAsync(caller.admin.invites.lookup({ handle: "mira_k" }), { code } as never);
    await t.throwsAsync(caller.admin.invites.grant({ handle: "mira_k", count: 1 }), {
      code,
    } as never);
  }
  t.is(accountInvites.allowance(harness.db, member.id).extra, 0);
});

test("I2: admin.invites.grant takes a whole count from 1 to 100", async (t) => {
  const harness = createHarness(t);
  const admin = harness.caller(harness.addUser("chief", { isAdmin: true }));
  const member = harness.addUser("mira_k");
  for (const count of [0, -1, 101, 1.5, Number.NaN]) {
    await t.throwsAsync(admin.admin.invites.grant({ handle: "mira_k", count }), {
      code: "BAD_REQUEST",
    } as never);
  }
  t.is(accountInvites.allowance(harness.db, member.id).extra, 0);
  t.like(await admin.admin.invites.grant({ handle: "mira_k", count: 1 }), { extra: 1 });
  t.like(await admin.admin.invites.grant({ handle: "mira_k", count: 100 }), { extra: 101 });
});

test("I2: an unknown, deleted or malformed handle answers not found", async (t) => {
  const harness = createHarness(t);
  const admin = harness.caller(harness.addUser("chief", { isAdmin: true }));
  const gone = harness.addUser("gone.member");
  accounts.deleteAccount(harness.db, gone.id);
  for (const handle of ["nobody.here", "gone.member", "", "@", "no spaces", "x".repeat(64)]) {
    await t.throwsAsync(admin.admin.invites.lookup({ handle }), {
      code: "NOT_FOUND",
      message: NOT_FOUND,
    } as never);
    await t.throwsAsync(admin.admin.invites.grant({ handle, count: 1 }), {
      code: "NOT_FOUND",
      message: NOT_FOUND,
    } as never);
  }
  t.deepEqual(harness.db.$client.prepare("SELECT count(*) AS n FROM user_limits").get(), { n: 0 });
});

test("I2: a grant is logged with the admin's and the member's ids and the count, nothing else", async (t) => {
  const harness = createHarness(t);
  const chief = harness.addUser("chief", { isAdmin: true });
  const member = harness.addUser("mira_k");
  await harness.caller(chief).admin.invites.grant({ handle: "mira_k", count: 2 });
  await harness.caller(chief).admin.invites.lookup({ handle: "mira_k" });
  const lines = harness.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["message"] === "invites granted");
  t.deepEqual(lines, [
    {
      level: "info",
      time: lines[0]?.["time"],
      message: "invites granted",
      adminId: chief.id,
      userId: member.id,
      count: 2,
    },
  ]);
  t.false(harness.logs.join("\n").includes("mira_k"));
});

test("limit: admin.invites.* shares the admin.models.* bucket, 60 a minute per site admin", async (t) => {
  const at = Date.now();
  const harness = createHarness(t, { limiterNow: () => at });
  const admin = harness.caller(harness.addUser("site.admin", { isAdmin: true }));
  const member = harness.addUser("mira_k");
  for (let index = 0; index < 30; index += 1) await admin.admin.models.list();
  for (let index = 0; index < 29; index += 1)
    await admin.admin.invites.lookup({ handle: "mira_k" });
  await admin.admin.invites.grant({ handle: "mira_k", count: 1 });
  await t.throwsAsync(admin.admin.invites.lookup({ handle: "mira_k" }), {
    code: "TOO_MANY_REQUESTS",
  } as never);
  await t.throwsAsync(admin.admin.invites.grant({ handle: "mira_k", count: 1 }), {
    code: "TOO_MANY_REQUESTS",
  } as never);
  await t.throwsAsync(admin.admin.models.list(), { code: "TOO_MANY_REQUESTS" } as never);
  t.is(accountInvites.allowance(harness.db, member.id).extra, 1);
  const other = harness.caller(harness.addUser("other.admin", { isAdmin: true }));
  await t.notThrowsAsync(other.admin.invites.lookup({ handle: "mira_k" }));
});
