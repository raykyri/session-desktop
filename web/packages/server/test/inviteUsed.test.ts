// The `invite_used` notification (`01` C16; `04` I4): written by the profile
// step's redemption, in its transaction, to the invite's creator, with the
// new member's handle and no code (`04` I1: no plain code is stored); none
// for a root invite. A notification that cannot be written rolls the
// redemption back.

import { accountInvites } from "@session/db";
import type { NotifRec } from "@session/mutators";
import test from "ava";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";
import { Person, keysOf } from "./syncHttp.js";

async function redeem(harness: Harness, code: string, login: string, handle: string) {
  const waiting = harness.addWaitingUser(login);
  const caller = harness.caller(waiting);
  const check = await caller.accountInvites.redeem({ code });
  if (check.status !== "open") throw new Error("expected an open code");
  return caller.account.create({ name: "New Member", handle });
}

const notifs = (records: { key: string; record?: unknown }[]) =>
  records
    .map((r) => r.record as NotifRec | undefined)
    .filter((r): r is NotifRec => r?.kind === "notif");

test("redeeming an invite notifies its creator in the same commit, with the handle and no code", async (t) => {
  const harness = createHarness(t);
  const inviter = new Person(harness, harness.addUser("inviter"));
  await inviter.register();
  const before = await inviter.snapshot("user:inviter");
  t.deepEqual(notifs(before.records), []);
  const stream = await inviter.events({ "user:inviter": before.cursor });
  const { code } = await harness.caller(inviter.user).accountInvites.create();

  await redeem(harness, code, "newcomer", "newcomer");

  // the inviter's stream is woken by the commit
  const event = await stream.until("changes", 3000);
  t.true(keysOf(event, "user:inviter").some((k) => k.startsWith("notif:")));
  await stream.close();
  const after = notifs((await inviter.snapshot("user:inviter")).records);
  t.is(after.length, 1);
  t.like(after[0], {
    to: "inviter",
    type: "invite_used",
    sp: null,
    th: null,
    item: null,
    actor: "newcomer",
    note: null,
    read: false,
    n: 1,
  });
  // the code is in no record
  const bodies = harness.sync.store.sqlite
    .prepare<[], { body: string }>("SELECT body FROM records")
    .all()
    .map((r) => r.body);
  t.false(bodies.some((b) => b.includes(code)));
});

test("a notification that cannot be written rolls the redemption back: the account waits and the invite stays open", async (t) => {
  const harness = createHarness(t);
  const inviter = new Person(harness, harness.addUser("inviter"));
  const { code } = await harness.caller(inviter.user).accountInvites.create();
  const waiting = harness.addWaitingUser("newcomer");
  const caller = harness.caller(waiting);
  await caller.accountInvites.redeem({ code });
  const server = harness.sync.server;
  const apply = server.serverApply.bind(server);
  server.serverApply = () => ({
    ok: false,
    error: { code: "INTERNAL_SERVER_ERROR", message: "refused here" },
  });
  try {
    await t.throwsAsync(caller.account.create({ name: "New Member", handle: "newcomer" }));
  } finally {
    server.serverApply = apply;
  }
  const row = harness.db.$client
    .prepare("SELECT status, handle FROM users WHERE id = ?")
    .get(waiting.id) as { status: string; handle: string | null };
  t.deepEqual(row, { status: "waiting", handle: null });
  const invite = harness.db.$client
    .prepare("SELECT used_by AS usedBy FROM invites WHERE created_by = ?")
    .get(inviter.user.id) as { usedBy: string | null };
  t.is(invite.usedBy, null);
  t.like(await harness.caller(null).auth.checkInvite({ code }), { status: "open" });
});

test("a root invite notifies nobody", async (t) => {
  const harness = createHarness(t);
  const { code } = accountInvites.createRoot(harness.db);
  const created = await redeem(harness, code, "first", "first");
  const first = new Person(harness, created.me);
  await first.register();
  t.deepEqual(notifs((await first.snapshot("user:first")).records), []);
  const rows = harness.sync.store.sqlite
    .prepare<[], { n: number }>("SELECT count(*) AS n FROM records WHERE kind = 'notif'")
    .get();
  t.is(rows?.n, 0);
});
