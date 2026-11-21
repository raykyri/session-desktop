// The `invite_used` notification (`01` C16; `04` I4): written by the profile
// step's redemption, in its transaction, to the invite's creator, with the
// new member's handle and the used code; none for a root invite.

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

test("redeeming an invite notifies its creator in the same commit, with the handle and the code", async (t) => {
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
    note: code,
    read: false,
    n: 1,
  });
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
