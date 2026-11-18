// Invariant 2: permissions are checked when the server applies a write, not
// when the client queued it. A write queued under a role the actor has lost
// is refused.

import test from "ava";

import type { InviteRec, ThreadRec } from "../src/index.js";

import { DAY, HOUR, admit, cast, ok, refused, thread } from "./harness.js";

test("a moderator's hide, queued before a demotion, is refused after it", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "mel", closed, "post");
  const mona = w.client("mona");
  mona.queue("moderation.decide", { item: `p:${th}`, decision: "hidden" });
  mona.queue("members.remove", { space: closed, user: "mel" });
  mona.queue("joinRequests.decide", { space: closed, users: ["mel"], decision: "decline" });
  w.clock.advance(HOUR);
  await ok(t, w.as("olga", "members.setRole", { space: closed, user: "mona", role: "member" }));
  const [hide, remove, decide] = await mona.flush();
  t.is(hide?.ok ? null : hide?.error.code, "FORBIDDEN");
  t.is(remove?.ok ? null : remove?.error.code, "FORBIDDEN");
  t.is(decide?.ok ? null : decide?.error.code, "FORBIDDEN");
  t.is((w.get(`thread:${th}`) as ThreadRec).mod, null);
  t.truthy(w.get(`member:${closed}:mel`));
});

test("a member's writes, queued before removal, are refused after it", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "olga", closed, "ask");
  const mel = w.client("mel");
  mel.queue("threads.create", { id: mel.newId(), space: closed, kind: "post", q: "queued" });
  mel.queue("followups.ask", { id: mel.newId(), thread: th, q: "queued" });
  mel.queue("likes.set", { thread: th, on: true });
  mel.queue("invites.create", { id: mel.newId(), space: closed });
  mel.queue("reports.create", { id: mel.newId(), item: `a:${th}`, why: "spam" });
  await ok(t, w.as("mona", "members.remove", { space: closed, user: "mel" }));
  const results = await mel.flush();
  // the thread is no longer readable by mel: NOT_FOUND, the same as a missing one
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["FORBIDDEN", "NOT_FOUND", "NOT_FOUND", "FORBIDDEN", "NOT_FOUND"],
  );
  const p = w.get(`thread:${th}`) as ThreadRec;
  t.is(p.r, 0);
  t.is(p.likes, 0);
  t.false([...w.server.dump().values()].some((r) => r.kind === "invite" || r.kind === "report"));
});

test("a ban stops writes queued before it, in a closed and in an open space", async (t) => {
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "olga", open, "post");
  const otto = w.client("otto");
  otto.queue("threads.create", { id: otto.newId(), space: open, kind: "post", q: "queued" });
  otto.queue("research.createPostFollowUp", { id: otto.newId(), thread: th, t: "queued" });
  await ok(t, w.as("mona", "members.ban", { space: open, user: "otto" }));
  const results = await otto.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["FORBIDDEN", "FORBIDDEN"],
  );
  // a banned person cannot join again, by any route
  await refused(t, w.as("otto", "spaces.join", { space: open }), "FORBIDDEN");
  const mel = w.client("mel");
  mel.queue("threads.create", { id: mel.newId(), space: closed, kind: "post", q: "queued" });
  await ok(t, w.as("mona", "members.ban", { space: closed, user: "mel" }));
  const [r] = await mel.flush();
  t.is(r?.ok ? null : r?.error.code, "FORBIDDEN");
  await refused(
    t,
    w.as("mel", "joinRequests.create", { space: closed, rulesAccepted: true }),
    "FORBIDDEN",
  );
});

test("an admin's role change, queued before losing admin, is refused", async (t) => {
  const { w, closed } = await cast(t);
  const ada = w.client("ada");
  ada.queue("members.setRole", { space: closed, user: "mel", role: "mod" });
  ada.queue("spaces.update", { id: closed, set: { vis: "open" } });
  await ok(t, w.as("olga", "members.setRole", { space: closed, user: "ada", role: "member" }));
  const results = await ada.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["FORBIDDEN", "FORBIDDEN"],
  );
  t.is((w.get(`member:${closed}:mel`) as { role: string }).role, "member");
});

test("an invite link works only while its maker may still make links", async (t) => {
  const { w, closed } = await cast(t);
  const res = (await ok(t, w.as("mel", "invites.create", { id: w.id(), space: closed }))) as {
    code: string;
  };
  await ok(t, w.as("mona", "members.remove", { space: closed, user: "mel" }));
  await refused(t, w.as("otto", "spaces.join", { space: closed, invite: res.code }), "FORBIDDEN");
  t.is(w.get(`member:${closed}:otto`), undefined);
  // and when the space stops letting members make links
  await admit(t, w, closed, "mel");
  const r2 = (await ok(t, w.as("mel", "invites.create", { id: w.id(), space: closed }))) as {
    code: string;
  };
  await ok(t, w.as("ada", "spaces.update", { id: closed, set: { invite: "mods" } }));
  await refused(t, w.as("otto", "spaces.join", { space: closed, invite: r2.code }), "FORBIDDEN");
  await ok(t, w.as("ada", "spaces.update", { id: closed, set: { invite: "members" } }));
  await ok(t, w.as("otto", "spaces.join", { space: closed, invite: r2.code }));
  const used = [...w.server.dump().values()].find(
    (r): r is InviteRec => r.kind === "invite" && r.code === r2.code,
  );
  t.is(used?.dead, "Used");
  t.is(used?.usedBy, "otto");
});

test("an approved request does not let a removed member back in", async (t) => {
  const { w, closed } = await cast(t);
  await admit(t, w, closed, "otto");
  await ok(t, w.as("mona", "members.remove", { space: closed, user: "otto" }));
  await refused(t, w.as("otto", "spaces.join", { space: closed }), "FORBIDDEN");
  t.is(w.get(`member:${closed}:otto`), undefined);
});

test("an expired invite link is refused at apply time, whatever the client saw", async (t) => {
  const { w, vault } = await cast(t);
  const res = (await ok(
    t,
    w.as("olga", "invites.create", { id: w.id(), space: vault, days: 1 }),
  )) as {
    code: string;
  };
  const otto = w.client("otto");
  otto.queue("spaces.join", { space: vault, invite: res.code });
  w.clock.advance(DAY + HOUR);
  const [r] = await otto.flush();
  t.is(r?.ok ? null : r?.error.code, "FORBIDDEN");
});

test("a write refused for lack of a role is applied once the role exists, under a new mutation id", async (t) => {
  const { w, closed } = await cast(t);
  const otto = w.client("otto");
  const e = otto.queue("threads.create", {
    id: otto.newId(),
    space: closed,
    kind: "post",
    q: "hi",
  });
  const [first] = await otto.flush();
  t.is(first?.ok ? null : first?.error.code, "FORBIDDEN");
  await admit(t, w, closed, "otto");
  // the same mutation id answers the stored refusal: the decision was made once
  const again = await w.server.apply({ u: "otto" }, e);
  t.false(again.ok);
  await ok(t, w.as("otto", "threads.create", { ...(e.input as object), id: w.id() }));
});
