// Invariant 2: permissions are checked when the server applies a write, not
// when the client queued it. A write queued under a membership the actor has
// lost is refused. A space has one owner for its lifetime (`01` C18), so no
// write is queued under a role that can be taken away; a membership and a
// ban can change.

import test from "ava";

import type { CountsRec, ThreadRec } from "../src/index.js";

import { DAY, HOUR, admit, cast, forkInput, ok, refused, thread, threadInput } from "./harness.js";

test("a member's writes, queued before removal, are refused after it", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "olga", closed, "ask");
  const mel = w.client("mel");
  mel.queue("threads.create", { id: mel.newId(), space: closed, kind: "post", q: "queued" });
  mel.queue("research.forkNode", forkInput(mel.newId(), th, "queued"));
  mel.queue("saved.set", { kind: "thread", id: th, on: true });
  mel.queue("invites.create", { id: mel.newId(), space: closed, days: 7 });
  mel.queue("comments.create", { id: mel.newId(), thread: th, node: "r", t: "queued" });
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  const results = await mel.flush();
  // the thread is no longer readable by mel: NOT_FOUND, the same as a missing one
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["FORBIDDEN", "NOT_FOUND", "NOT_FOUND", "FORBIDDEN", "NOT_FOUND"],
  );
  const p = w.get(`counts:${th}`) as CountsRec;
  t.is(p.r, 0);
  t.is(p.saves, 0);
  t.false(
    [...w.server.dump().values()].some(
      (r) => r.kind === "invite" || r.kind === "comment" || r.kind === "node" || r.kind === "save",
    ),
  );
});

test("a ban stops writes queued before it, in a private and in an open space", async (t) => {
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "olga", open, "post");
  const otto = w.client("otto");
  otto.queue("threads.create", { id: otto.newId(), space: open, kind: "post", q: "queued" });
  otto.queue("research.createPostFollowUp", { id: otto.newId(), thread: th, t: "queued" });
  await ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
  const results = await otto.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["FORBIDDEN", "FORBIDDEN"],
  );
  // a banned person cannot join again, by any route
  await refused(t, w.as("otto", "spaces.join", { space: open }), "FORBIDDEN");
  const mel = w.client("mel");
  mel.queue("threads.create", { id: mel.newId(), space: closed, kind: "post", q: "queued" });
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "mel" }));
  const [r] = await mel.flush();
  t.is(r?.ok ? null : r?.error.code, "FORBIDDEN");
  await refused(t, w.as("mel", "joinRequests.create", { space: closed }), "FORBIDDEN");
});

test("a ban stops every write in its space, the author's own included", async (t) => {
  // attack A of the phase 0 review: a banned author kept editing, liking and
  // deleting their thread in an open space
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "otto", open, "post", "fine");
  const ask = await thread(t, w, "otto", open, "ask", "fine");
  const reply = w.id();
  await ok(t, w.as("mel", "research.createPostFollowUp", { id: reply, thread: th, t: "hi" }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: ask, on: true }));
  const rev = w.get(`thread:${th}`)?.rev ?? 0;
  await ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
  const before = JSON.stringify([...w.server.dump()]);
  for (const [name, input] of [
    ["threads.update", { id: th, q: "abuse after the ban", base: { rev } }],
    ["threads.delete", { id: th }],
    ["saved.set", { kind: "thread", id: th, on: true }],
    ["research.createPostFollowUp", { id: w.id(), thread: th, t: "abuse" }],
    ["research.createPostFollowUp", { id: w.id(), thread: th, t: "abuse", parent: reply }],
    ["research.forkNode", forkInput(w.id(), ask, "abuse")],
    ["comments.create", { id: w.id(), thread: ask, node: "r", t: "abuse" }],
    ["threads.create", { id: w.id(), space: open, kind: "post", q: "abuse" }],
    ["spaces.join", { space: open }],
    ["spaces.leave", { space: open }],
  ] as const)
    await refused(t, w.as("otto", name, input), "FORBIDDEN");
  t.is(JSON.stringify([...w.server.dump()]), before);
  t.is((w.get(`thread:${th}`) as ThreadRec).q, "fine");
  // the person's own user-log writes are not stopped (M1b review 11): taking
  // a save back
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: ask, on: false }));
  t.is(w.get(`save:otto:${ask}`), undefined);
  // the same in a private space, and a ban is per space: otto still writes elsewhere
  await admit(t, w, closed, "otto");
  const mine = await thread(t, w, "otto", closed, "post");
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "otto" }));
  await refused(t, w.as("otto", "threads.delete", { id: mine }), "FORBIDDEN");
  await refused(
    t,
    w.as("otto", "threads.update", { id: mine, q: "x", base: { rev: 1 } }),
    "NOT_FOUND",
  );
  const vault = w.id();
  await ok(t, w.as("otto", "spaces.create", { id: vault, name: "otto" }));
  await thread(t, w, "otto", vault, "post");
  // taking back a save you do not have writes nothing and is not refused
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: false }));
});

test("a queued approval does not re-admit a person who was approved and then removed", async (t) => {
  // attack N of the phase 0 review: the decision acted on a request that was
  // no longer open. The owner decides on two devices.
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  const phone = w.client("olga");
  phone.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "approve",
    base: w.requests(closed, ["otto"]),
  });
  phone.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "decline",
    base: w.requests(closed, ["otto"]),
  });
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "otto",
      base: w.admission(closed, "otto"),
    }),
  );
  // the approval is STALE; a decline applies to the request as it is now,
  // and it was decided already (review round 2, finding 2)
  const results = await phone.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["STALE", "PRECONDITION_FAILED"],
  );
  t.is(w.get(`member:${closed}:otto`), undefined);
  t.is(w.get(`request:${closed}:otto`)?.kind === "request" ? "approved" : null, "approved");
  // with the current rev, reopening needs a declined request
  await refused(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "reopen",
      base: w.requests(closed, ["otto"]),
    }),
    "PRECONDITION_FAILED",
  );
});

test("a queued show or edit acts only on the state it was made from", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "mel", closed, "post");
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  const rev = w.get(`thread:${th}`)?.rev ?? 0;
  // olga read the hidden text on her phone and decides to show it
  const phone = w.client("olga");
  phone.queue("moderation.decide", { item: `p:${th}`, decision: "shown", base: w.item(`p:${th}`) });
  const mel = w.client("mel");
  mel.queue("threads.update", { id: th, q: "laptop", base: { rev } });
  // meanwhile mel edits the hidden thread from the phone
  await ok(t, w.as("mel", "threads.update", { id: th, q: "phone", base: { rev } }));
  for (const c of [phone, mel]) {
    const [r] = await c.flush();
    t.is(r?.ok ? "ok" : r?.error.code, "STALE", c.actor?.u);
  }
  t.is((w.get(`thread:${th}`) as ThreadRec).q, "phone");
  t.is((w.get(`thread:${th}`) as ThreadRec).mod, "hidden");
  // with the current rev, showing needs the item hidden
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th}`,
      decision: "shown",
      base: w.item(`p:${th}`),
    }),
  );
  await refused(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th}`,
      decision: "shown",
      base: w.item(`p:${th}`),
    }),
    "PRECONDITION_FAILED",
  );
  // a "shown" without a base is refused; "hidden" and "removed" need none
  await refused(
    t,
    w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "shown" }),
    "BAD_REQUEST",
  );
  await ok(t, w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "hidden" }));
});

test("a member's writes in a private space work only while they are a member", async (t) => {
  const { w, closed } = await cast(t);
  const ask = await thread(t, w, "olga", closed, "ask");
  await ok(t, w.as("mel", "research.forkNode", forkInput(w.id(), ask, "Why?")));
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  await refused(t, w.as("mel", "research.forkNode", forkInput(w.id(), ask, "Why?")), "NOT_FOUND");
  await admit(t, w, closed, "mel");
  await ok(t, w.as("mel", "research.forkNode", forkInput(w.id(), ask, "Why?")));
});

test("an approved request does not let a removed member back in", async (t) => {
  const { w, closed } = await cast(t);
  await admit(t, w, closed, "otto");
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "otto",
      base: w.admission(closed, "otto"),
    }),
  );
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
  const e = otto.queue("threads.create", threadInput(otto.newId(), closed, "post", "hi"));
  const [first] = await otto.flush();
  t.is(first?.ok ? null : first?.error.code, "FORBIDDEN");
  await admit(t, w, closed, "otto");
  // the same mutation id answers the stored refusal: the decision was made once
  const again = await w.server.apply({ u: "otto" }, otto.sent.at(-1)!);
  t.false(again.ok);
  await ok(t, w.as("otto", "threads.create", { ...(e.input as object), id: w.id() }));
});
