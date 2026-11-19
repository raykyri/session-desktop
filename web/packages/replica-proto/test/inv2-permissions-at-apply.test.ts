// Invariant 2: permissions are checked when the server applies a write, not
// when the client queued it. A write queued under a role the actor has lost
// is refused.

import test from "ava";

import type { CountsRec, InviteRec, ThreadRec } from "../src/index.js";

import { DAY, HOUR, admit, cast, ok, refused, thread } from "./harness.js";

test("a moderator's hide, queued before a demotion, is refused after it", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "mel", closed, "post");
  const mona = w.client("mona");
  mona.queue("moderation.decide", { item: `p:${th}`, decision: "hidden", base: w.item(`p:${th}`) });
  mona.queue("members.remove", { space: closed, user: "mel", base: w.admission(closed, "mel") });
  mona.queue("joinRequests.decide", {
    space: closed,
    users: ["mel"],
    decision: "decline",
    base: w.requests(closed, ["mel"]),
  });
  w.clock.advance(HOUR);
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mona",
      role: "member",
      base: w.member(closed, "mona"),
    }),
  );
  const [hide, remove, decide] = await mona.flush();
  t.is(hide?.ok ? null : hide?.error.code, "FORBIDDEN");
  t.is(remove?.ok ? null : remove?.error.code, "FORBIDDEN");
  t.is(decide?.ok ? null : decide?.error.code, "FORBIDDEN");
  t.is(w.mod(`thread:${th}`), null);
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
  await ok(
    t,
    w.as("mona", "members.remove", {
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

test("a ban stops every write in its space, the author's own included", async (t) => {
  // attack A of the phase 0 review: a banned author kept editing, liking and
  // deleting their thread in an open space
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "otto", open, "post", "fine");
  const ask = await thread(t, w, "otto", open, "ask", "fine");
  const reply = w.id();
  await ok(t, w.as("mel", "research.createPostFollowUp", { id: reply, thread: th, t: "hi" }));
  await ok(t, w.as("otto", "likes.set", { thread: ask, on: true }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: ask, on: true }));
  const rev = w.get(`thread:${th}`)?.rev ?? 0;
  await ok(t, w.as("mona", "members.ban", { space: open, user: "otto" }));
  const before = JSON.stringify([...w.server.dump()]);
  for (const [name, input] of [
    ["threads.update", { id: th, q: "abuse after the ban", base: { rev } }],
    ["threads.delete", { id: th }],
    ["likes.set", { thread: th, on: true }],
    ["likes.set", { thread: ask, on: false }],
    ["saved.set", { kind: "thread", id: th, on: true }],
    ["saved.set", { kind: "thread", id: ask, on: false }],
    ["research.createPostFollowUp", { id: w.id(), thread: th, t: "abuse" }],
    ["research.createPostFollowUp", { id: w.id(), thread: th, t: "abuse", parent: reply }],
    ["followups.ask", { id: w.id(), thread: ask, q: "abuse" }],
    ["reports.create", { id: w.id(), item: `p:${th}`, why: "abuse" }],
    ["threads.create", { id: w.id(), space: open, kind: "post", q: "abuse" }],
    ["spaces.join", { space: open }],
    ["spaces.leave", { space: open }],
  ] as const)
    await refused(t, w.as("otto", name, input), "FORBIDDEN");
  t.is(JSON.stringify([...w.server.dump()]), before);
  t.is((w.get(`thread:${th}`) as ThreadRec).q, "fine");
  // the same in a closed space, and a ban is per space: otto still writes elsewhere
  await admit(t, w, closed, "otto");
  const mine = await thread(t, w, "otto", closed, "post");
  await ok(t, w.as("mona", "members.ban", { space: closed, user: "otto" }));
  await refused(t, w.as("otto", "threads.delete", { id: mine }), "FORBIDDEN");
  await refused(
    t,
    w.as("otto", "threads.update", { id: mine, q: "x", base: { rev: 1 } }),
    "NOT_FOUND",
  );
  const vault = w.id();
  await ok(t, w.as("otto", "spaces.create", { id: vault, name: "otto" }));
  await thread(t, w, "otto", vault, "post");
  // taking back a like or a save you do not have writes nothing and is not refused
  await ok(t, w.as("otto", "likes.set", { thread: th, on: false }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: false }));
});

test("a queued approval does not re-admit a person who was approved and then removed", async (t) => {
  // attack N of the phase 0 review: the decision acted on a request that was
  // no longer open
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  const mona = w.client("mona");
  mona.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "approve",
    base: w.requests(closed, ["otto"]),
  });
  mona.queue("joinRequests.decide", {
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
  const results = await mona.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["STALE", "PRECONDITION_FAILED"],
  );
  t.is(w.get(`member:${closed}:otto`), undefined);
  t.is(w.get(`request:${closed}:otto`)?.kind === "request" ? "approved" : null, "approved");
  // with the current rev, reopening needs a declined request
  await refused(
    t,
    w.as("mona", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "reopen",
      base: w.requests(closed, ["otto"]),
    }),
    "PRECONDITION_FAILED",
  );
});

test("a queued role change, show, or edit acts only on the state it was made from", async (t) => {
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
  const ada = w.client("ada");
  ada.queue("members.setRole", {
    space: closed,
    user: "mel",
    role: "mod",
    base: w.member(closed, "mel"),
  });
  // mona read the hidden text and decides to show it
  const mona = w.client("mona");
  mona.queue("moderation.decide", { item: `p:${th}`, decision: "shown", base: w.item(`p:${th}`) });
  const mel = w.client("mel");
  mel.queue("threads.update", { id: th, q: "laptop", base: { rev } });
  // meanwhile: olga makes mel a moderator; mel edits the hidden thread from the phone
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mel",
      role: "mod",
      base: w.member(closed, "mel"),
    }),
  );
  await ok(t, w.as("mel", "threads.update", { id: th, q: "phone", base: { rev } }));
  for (const c of [ada, mona, mel]) {
    const [r] = await c.flush();
    t.is(r?.ok ? "ok" : r?.error.code, "STALE", c.actor?.u);
  }
  t.is((w.get(`thread:${th}`) as ThreadRec).q, "phone");
  t.is(w.mod(`thread:${th}`), "hidden");
  // with the current rev, showing needs the item hidden
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "shown",
      base: w.item(`p:${th}`),
    }),
  );
  await refused(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "shown",
      base: w.item(`p:${th}`),
    }),
    "PRECONDITION_FAILED",
  );
});

test("an admin's role change, queued before losing admin, is refused", async (t) => {
  const { w, closed } = await cast(t);
  const ada = w.client("ada");
  ada.queue("members.setRole", {
    space: closed,
    user: "mel",
    role: "mod",
    base: w.member(closed, "mel"),
  });
  ada.queue("spaces.update", { id: closed, set: { vis: "open" } });
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "ada",
      role: "member",
      base: w.member(closed, "ada"),
    }),
  );
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
  await ok(
    t,
    w.as("mona", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
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

test("a link that stopped working when its maker lost the right works again once the maker has it back", async (t) => {
  const { w, closed } = await cast(t);
  const res = (await ok(t, w.as("mel", "invites.create", { id: w.id(), space: closed }))) as {
    code: string;
  };
  await ok(
    t,
    w.as("mona", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  await refused(t, w.as("otto", "spaces.join", { space: closed, invite: res.code }), "FORBIDDEN");
  await admit(t, w, closed, "mel");
  await ok(t, w.as("otto", "spaces.join", { space: closed, invite: res.code }));
  t.truthy(w.get(`member:${closed}:otto`));
});

test("an approved request does not let a removed member back in", async (t) => {
  const { w, closed } = await cast(t);
  await admit(t, w, closed, "otto");
  await ok(
    t,
    w.as("mona", "members.remove", {
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
  const again = await w.server.apply({ u: "otto" }, otto.sent.at(-1)!);
  t.false(again.ok);
  await ok(t, w.as("otto", "threads.create", { ...(e.input as object), id: w.id() }));
});
