// Account invites, the profile step and the invite tree over tRPC (plan
// `04` I2-I4 server acceptance).

import { accountInvites, accounts } from "@session/db";
import test from "ava";

import { createSecretBox } from "../src/secretBox.js";

import type { Harness } from "./helpers.js";
import { PUBLIC_ORIGIN, createHarness } from "./helpers.js";

/** A waiting account with a pending invite from `code`, as the callback or
 * `accountInvites.redeem` leaves it. */
async function pendingWith(harness: Harness, code: string, login: string) {
  const waiting = harness.addWaitingUser(login);
  const check = await harness.caller(waiting).accountInvites.redeem({ code });
  if (check.status !== "open") throw new Error("expected an open code");
  return waiting;
}

const AT_LIMIT = "You have used your 3 invites. An admin can give you more.";

test("I2: 3 invites in all; a used link spends one, an open one holds one, a revoked one gives it back", async (t) => {
  const harness = createHarness(t);
  const member = harness.addUser("ines.v");
  const caller = harness.caller(member);
  const allowance = async () => (await caller.accountInvites.list()).allowance;
  t.deepEqual(await allowance(), { total: 3, used: 0, left: 3 });
  const links = [
    await caller.accountInvites.create(),
    await caller.accountInvites.create(),
    await caller.accountInvites.create(),
  ];
  t.regex(links[0]?.code ?? "", /^SESS-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  t.is(links[0]?.link, `${PUBLIC_ORIGIN}/i#${links[0]?.code ?? ""}`);
  // Three open links hold all three invites.
  t.deepEqual(await allowance(), { total: 3, used: 0, left: 0 });
  await t.throwsAsync(caller.accountInvites.create(), {
    code: "PRECONDITION_FAILED",
    message: AT_LIMIT,
  } as never);
  // Revoking an unused link gives its invite back.
  await caller.accountInvites.revoke({ id: links[0]?.id ?? "" });
  t.deepEqual(await allowance(), { total: 3, used: 0, left: 1 });
  await t.notThrowsAsync(caller.accountInvites.create());
  await t.throwsAsync(caller.accountInvites.create(), { message: AT_LIMIT });
  // A used link spends its invite: using it gives nothing back.
  const joiner = await pendingWith(harness, links[1]?.code ?? "", "joiner");
  await harness.caller(joiner).account.create({ name: "Joiner", handle: "joiner" });
  t.deepEqual(await allowance(), { total: 3, used: 1, left: 0 });
  await t.throwsAsync(caller.accountInvites.create(), { message: AT_LIMIT });
  await t.throwsAsync(caller.accountInvites.revoke({ id: links[1]?.id ?? "" }), {
    code: "NOT_FOUND",
  } as never);

  const view = await caller.accountInvites.list();
  t.is(view.openCount, 2);
  t.is(view.perMember, 3);
  t.deepEqual(view.links.map((link) => link.state).sort(), ["open", "open", "revoked", "used"]);
  // Open links carry their code for the creator; used and revoked ones none.
  for (const link of view.links) {
    t.is(link.code === null, link.state !== "open", link.state);
  }
  t.deepEqual(view.links.find((link) => link.state === "used")?.usedBy, {
    handle: "joiner",
    displayName: "Joiner",
  });
  t.deepEqual(
    view.invited.map((person) => person.handle),
    ["joiner"],
  );
});

test("I2: the refusal at 0 left names the member's total, extra invites included", async (t) => {
  const harness = createHarness(t);
  const member = harness.addUser("mira_k");
  const caller = harness.caller(member);
  accountInvites.grant(harness.db, member.id, 2);
  for (let index = 0; index < 5; index += 1) await caller.accountInvites.create();
  await t.throwsAsync(caller.accountInvites.create(), {
    code: "PRECONDITION_FAILED",
    message: "You have used your 5 invites. An admin can give you more.",
  } as never);
  t.deepEqual((await caller.accountInvites.list()).allowance, { total: 5, used: 0, left: 0 });
  // Each create refused at the limit made nothing.
  t.is(accountInvites.listForCreator(harness.db, member.id).length, 5);
});

test("I2: SESSION_INVITES_PER_MEMBER is each member's total; it is validated at boot", async (t) => {
  const harness = createHarness(t, { env: { SESSION_INVITES_PER_MEMBER: "1" } });
  t.is(harness.config.abuse.invitesPerMember, 1);
  const caller = harness.caller(harness.addUser("solo"));
  await caller.accountInvites.create();
  await t.throwsAsync(caller.accountInvites.create(), {
    message: "You have used your 1 invite. An admin can give you more.",
  });
  const view = await caller.accountInvites.list();
  t.deepEqual(view.allowance, { total: 1, used: 0, left: 0 });
  t.is(view.perMember, 1);
  t.is(createHarness(t).config.abuse.invitesPerMember, 3);
  for (const value of ["0", "-1", "2.5", "three"]) {
    t.throws(() => createHarness(t, { env: { SESSION_INVITES_PER_MEMBER: value } }), {
      message: /SESSION_INVITES_PER_MEMBER/,
    });
  }
});

test("two concurrent creates with one invite left make one link", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("racer"));
  await caller.accountInvites.create();
  await caller.accountInvites.create();
  const outcomes = await Promise.allSettled([
    caller.accountInvites.create(),
    caller.accountInvites.create(),
  ]);
  t.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
  t.is((await caller.accountInvites.list()).openCount, 3);
});

test("I2: site admins have no invite limit", async (t) => {
  const harness = createHarness(t);
  const chief = harness.addUser("chief", { isAdmin: true });
  const caller = harness.caller(chief);
  for (let index = 0; index < 6; index += 1) await caller.accountInvites.create();
  const view = await caller.accountInvites.list();
  t.is(view.openCount, 6);
  t.is(view.allowance, null);
  // Each link still counts, should the account stop being a site admin.
  t.like(accountInvites.allowance(harness.db, chief.id), { open: 6, left: 0 });
});

test("another account's list never contains the caller's codes", async (t) => {
  const harness = createHarness(t);
  const mine = await harness.caller(harness.addUser("owner.one")).accountInvites.create();
  const other = await harness.caller(harness.addUser("owner.two")).accountInvites.list();
  t.false(JSON.stringify(other).includes(mine.code));
  t.deepEqual(other.links, []);
  // A code sealed for one account does not open as another's.
  const box = createSecretBox(harness.config.secretKey);
  const sealed = box.seal(mine.code, "account-invite:A");
  t.is(box.open(sealed, "account-invite:A"), mine.code);
  t.throws(() => box.open(sealed, "account-invite:B"));
  const stored = harness.db.$client.prepare(`SELECT code_enc AS enc FROM invites`).get() as {
    enc: string;
  };
  t.false(stored.enc.includes(mine.code));
});

test("checkInvite answers byte-identical bodies for used, revoked and unknown codes", async (t) => {
  const harness = createHarness(t);
  const member = harness.addUser("sender");
  const caller = harness.caller(member);
  const used = await caller.accountInvites.create();
  const revoked = await caller.accountInvites.create();
  const valid = await caller.accountInvites.create();
  await caller.accountInvites.revoke({ id: revoked.id });
  const joiner = await pendingWith(harness, used.code, "user.used");
  await harness.caller(joiner).account.create({ name: "Used", handle: "user.used" });

  const check = async (code: string) => {
    const response = await harness.request("/api/trpc/auth.checkInvite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return { status: response.status, body: await response.text() };
  };
  const bodies = await Promise.all([
    check(used.code),
    check(revoked.code),
    check("SESS-ZZZZ-ZZ"),
    check("nonsense"),
  ]);
  t.true(bodies.every((entry) => entry.status === 200));
  t.is(new Set(bodies.map((entry) => entry.body)).size, 1, bodies[0]?.body);
  const open = await check(valid.link);
  t.deepEqual(JSON.parse(open.body), {
    result: { data: { status: "open", inviter: { name: "sender", handle: "sender" } } },
  });
});

test("the profile step: name and handle rules, taken handles, a used invite", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("inviter"));
  const first = await caller.accountInvites.create();
  const waiting = await pendingWith(harness, first.code, "newcomer");
  const profile = harness.caller(waiting);
  t.deepEqual((await profile.auth.me())?.pendingInvite, { name: "inviter", handle: "inviter" });
  await t.throwsAsync(profile.account.create({ name: "  ", handle: "newcomer" }), {
    message: "Enter a name.",
  });
  await t.throwsAsync(profile.account.create({ name: "New", handle: "No" }), {
    message: "Handles use 3 to 20 lowercase letters, numbers, dots or underscores.",
  });
  await t.throwsAsync(profile.account.create({ name: "New", handle: "inviter" }), {
    message: "@inviter is taken. Try another.",
  });
  t.deepEqual(await profile.account.checkHandle({ handle: "inviter" }), {
    valid: true,
    available: false,
  });
  t.deepEqual(await profile.account.checkHandle({ handle: "brand.new" }), {
    valid: true,
    available: true,
  });
  // Someone else redeems the same code first.
  const rival = await pendingWith(harness, first.code, "rival");
  const { me: active } = await harness
    .caller(rival)
    .account.create({ name: "Rival", handle: "rival" });
  await t.throwsAsync(profile.account.create({ name: "New", handle: "brand.new" }), {
    message: "This invite code doesn't work. Ask the person who invited you for a new one.",
  });
  t.is((await profile.auth.me())?.pendingInvite, null);
  // An active account cannot redeem again.
  await t.throwsAsync(harness.caller(active).accountInvites.redeem({ code: first.code }), {
    message: "Your account is already active. Reload to continue.",
  });
});

test("waiting accounts cannot make or list invites", async (t) => {
  const harness = createHarness(t);
  const waiting = harness.caller(harness.addWaitingUser("waits"));
  await t.throwsAsync(waiting.accountInvites.create(), { code: "FORBIDDEN" } as never);
  await t.throwsAsync(waiting.accountInvites.list(), { code: "FORBIDDEN" } as never);
  await t.throwsAsync(harness.caller(null).accountInvites.list(), {
    code: "UNAUTHORIZED",
  } as never);
});

test("members.tree: refused to waiting and signed-out callers; a deleted account stays a node", async (t) => {
  const harness = createHarness(t);
  const root = harness.addUser("root.admin", { isAdmin: true });
  const child = harness.addUser("child", { invitedBy: root.id });
  const grandchild = harness.addUser("grandchild", { invitedBy: child.id });
  await t.throwsAsync(harness.caller(harness.addWaitingUser("waiting")).members.tree(), {
    code: "FORBIDDEN",
  } as never);
  await t.throwsAsync(harness.caller(null).members.tree(), { code: "UNAUTHORIZED" } as never);

  accounts.deleteAccount(harness.db, child.id);
  const tree = await harness.caller(grandchild).members.tree();
  t.deepEqual(
    tree.map((node) => [node.handle, node.invitedBy, node.staff]),
    [
      ["root.admin", null, "admin"],
      [null, root.id, null],
      ["grandchild", child.id, null],
    ],
  );
  t.is(tree[1]?.id, child.id);
});

test("a root invite's redeemer has no inviter", async (t) => {
  const harness = createHarness(t);
  const { code } = accountInvites.createRoot(harness.db);
  const first = await pendingWith(harness, code, "first");
  const me = await harness.caller(first).auth.me();
  t.deepEqual(me?.pendingInvite, accountInvites.ROOT_INVITER);
  const created = await harness.caller(first).account.create({ name: "First", handle: "first" });
  t.deepEqual(created.inviter, accountInvites.ROOT_INVITER);
  const tree = await harness.caller(created.me).members.tree();
  t.deepEqual(
    tree.map((node) => [node.handle, node.invitedBy]),
    [["first", null]],
  );
});
