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

test("3 open links, a 4th refused; revoke and use each free a slot", async (t) => {
  const harness = createHarness(t);
  const member = harness.addUser("ines.v");
  const caller = harness.caller(member);
  const links = [
    await caller.accountInvites.create(),
    await caller.accountInvites.create(),
    await caller.accountInvites.create(),
  ];
  t.regex(links[0]?.code ?? "", /^SESS-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  t.is(links[0]?.link, `${PUBLIC_ORIGIN}/i#${links[0]?.code ?? ""}`);
  await t.throwsAsync(caller.accountInvites.create(), {
    message: "You have 3 open invites. One frees when it is used or revoked.",
  });
  await caller.accountInvites.revoke({ id: links[0]?.id ?? "" });
  await t.notThrowsAsync(caller.accountInvites.create());
  await t.throwsAsync(caller.accountInvites.create());
  const joiner = await pendingWith(harness, links[1]?.code ?? "", "joiner");
  await harness.caller(joiner).account.create({ name: "Joiner", handle: "joiner" });
  await t.notThrowsAsync(caller.accountInvites.create());

  const view = await caller.accountInvites.list();
  t.is(view.openCount, 3);
  t.is(view.openLimit, 3);
  t.deepEqual(view.links.map((link) => link.state).sort(), [
    "open",
    "open",
    "open",
    "revoked",
    "used",
  ]);
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

test("two concurrent creates at 2 open links leave 3", async (t) => {
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

test("site admins are exempt from the open-links limit", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("chief", { isAdmin: true }));
  for (let index = 0; index < 6; index += 1) await caller.accountInvites.create();
  const view = await caller.accountInvites.list();
  t.is(view.openCount, 6);
  t.is(view.openLimit, null);
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
    message: "Your account is already active.",
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
