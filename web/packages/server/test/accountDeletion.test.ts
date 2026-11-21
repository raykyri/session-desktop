// The account-deletion operator job in the spaces (plan `04` B6, P2): the
// channels of a deleted owner are frozen and stay readable; a deleted
// member's items go through the author's delete path and their user log and
// memberships go; the handle stays taken and the identity is gone.

import { accounts, users } from "@session/db";
import { frozenMessage, type StoredRecord } from "@session/mutators";
import type { Snapshot } from "@session/sync/server";
import test from "ava";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";
import { Person, channels, newId } from "./syncHttp.js";

/** The job, through the server's own sync core, as the outer transaction so
 * the commit wakes the streams. */
function deleteAccount(h: Harness, userId: string) {
  return h.sync.store.transaction(() =>
    accounts.deleteAccount(h.db, userId, { server: h.sync.server }),
  );
}

async function signedOutSnapshot(h: Harness, log: string): Promise<Snapshot> {
  const res = await h.request("/api/sync/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ log }),
  });
  return (await res.json()) as Snapshot;
}

const keys = (s: Snapshot) => s.records.map((r) => r.key);

function stored(h: Harness): StoredRecord[] {
  return h.sync.store.sqlite
    .prepare<[], { body: string }>("SELECT body FROM records")
    .all()
    .map((r) => JSON.parse(r.body) as StoredRecord);
}

test("B6: the frozen channels of a deleted owner", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  const eve = new Person(h, h.addUser("eve"));
  const post = newId();
  await mona.ok("threads.create", { id: post, space: open, kind: "post", q: "Mona's post" });
  const secret = newId();
  await mel.ok("threads.create", { id: secret, space: closed, kind: "post", q: "Lab notes" });
  const link = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };

  const done = deleteAccount(h, olga.user.id);
  t.deepEqual(done.spaces?.frozen.sort(), ["lab", "lounge"]);

  const refusal = await mona.write("threads.create", {
    id: newId(),
    space: open,
    kind: "post",
    q: "After",
  });
  t.like(refusal, { ok: false, error: { code: "FORBIDDEN", message: frozenMessage("lounge") } });
  t.like(await eve.write("spaces.join", { space: open }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  t.like(await eve.write("spaces.join", { space: closed, invite: link.code }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  // a person still deletes their own thread
  t.like(await mona.write("threads.delete", { id: post }), { ok: true });

  // readable as before: the open channel by anyone, the private one by its members
  const lounge = await signedOutSnapshot(h, `space:${open}`);
  t.true(keys(lounge).includes(`space:${open}`));
  t.true(keys(lounge).includes(`thread:${post}`));
  const space = lounge.records.find((r) => r.key === `space:${open}`)?.record;
  t.like(space, { frozen: true, owner: "olga" });
  const lab = await mel.snapshot(`space:${closed}`);
  t.true(keys(lab).includes(`thread:${secret}`));
  t.false(keys(await signedOutSnapshot(h, `space:${closed}`)).includes(`thread:${secret}`));

  // the handle stays taken; the identity is gone
  const row = users.findByHandle(h.db, "olga");
  t.is(row?.provider ?? null, null);
  t.is(row?.providerUserId ?? null, null);
  t.false(users.handleAvailable(h.db, "olga"));
});

test("P2: a deleted member's items go by the author's delete path; their user log, memberships, bans and links go", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  // mel's post with mona's reply stays as an empty shell; mel's lone post goes
  const replied = newId();
  await mel.ok("threads.create", { id: replied, space: open, kind: "post", q: "Replied to" });
  await mona.ok("research.createPostFollowUp", { id: newId(), thread: replied, t: "A reply" });
  const lone = newId();
  await mel.ok("threads.create", { id: lone, space: closed, kind: "post", q: "Alone" });
  const reply = newId();
  const monas = newId();
  await mona.ok("threads.create", { id: monas, space: open, kind: "post", q: "Mona's" });
  await mel.ok("research.createPostFollowUp", { id: reply, thread: monas, t: "Mel's reply" });
  await mel.ok("saved.set", { kind: "thread", id: monas, on: true });
  await mona.ok("research.createPostFollowUp", {
    id: newId(),
    thread: monas,
    t: "Thanks @mel",
  });
  await olga.ok("members.ban", { space: open, user: "mona" });
  await olga.ok("members.unban", { space: open, user: "mona" });

  const done = deleteAccount(h, mel.user.id);
  t.like(done.spaces, { items: 3 });
  const left = stored(h);
  const mine = left.filter(
    (r) =>
      ("u" in r && r.u === "mel") ||
      (r.kind === "notif" && r.to === "mel") ||
      (r.kind === "invite" && r.by === "mel"),
  );
  // only mel's two threads name mel, deleted and with no text: the one with
  // mona's reply is a shell, the other is gone
  t.deepEqual(
    mine.map((r) => (r.kind === "thread" ? [r.id, r.q, r.del, r.gone] : r.kind)).sort(),
    [
      [replied, "", true, false],
      [lone, "", true, true],
    ].sort(),
  );
  t.false(left.some((r) => r.kind === "reply" && r.id === reply));
  t.false(left.some((r) => r.kind === "member" && r.u === "mel"));
  // the member counts follow: olga is left, mona's ban took her membership
  const lounge = left.find((r) => r.kind === "space" && r.id === open);
  t.like(lounge, { members: 1, frozen: false });
  // moderation log entries stay until retention
  t.true(left.some((r) => r.kind === "modlog" && r.author === "mona"));
  t.false(users.handleAvailable(h.db, "mel"));
});
