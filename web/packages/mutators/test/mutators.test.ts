// Mutator by mutator: what each writes, its refusals (stale intent, state),
// its effects and its derived ids.

import test from "ava";

import { MUTATORS, deriveId, type StoredRecord } from "../src/index.js";

import { DAY, admit, cast, ok, refused, thread, World } from "./world.js";

const rec = <K extends StoredRecord["kind"]>(w: World, key: string, kind: K) => {
  const r = w.get(key);
  if (r?.kind !== kind) throw new Error(`${key}: no ${kind}`);
  return r as Extract<StoredRecord, { kind: K }>;
};

// ---- spaces ----

test("spaces.create: the owner's membership, stats and a derived admission id; names are unique", (t) => {
  const w = new World(1);
  const id = w.id();
  const mid = w.id();
  t.deepEqual(ok(t, w.run("olga", "spaces.create", { id, name: "#My Space!", faq: true }, mid)), {
    id,
  });
  const s = rec(w, `space:${id}`, "space");
  t.like(s, {
    name: "my-space-",
    title: "my-space-",
    vis: "open",
    members: 1,
    faq: true,
    deleted: false,
  });
  t.deepEqual(s.mods, [["olga", "owner"]]);
  t.is(rec(w, `member:${id}:olga`, "member").adm, deriveId("olga", mid, 1));
  t.like(rec(w, `stats:${id}`, "stats"), { posts: 0 });
  const again = w.run("eve", "spaces.create", { id: w.id(), name: "my space " });
  refused(t, again, "CONFLICT");
  // an id that was used is CONFLICT, whatever its record
  refused(t, w.run("eve", "spaces.create", { id, name: "other" }), "CONFLICT");
  // online only: a mutation id over a minute old on the device's clock
  const old = w.id();
  w.advance(2 * 60_000);
  refused(t, w.run("eve", "spaces.create", { id: w.id(), name: "late" }, old), "EXPIRED");
});

test("spaces.update: settings, unset, rules history, topics move threads, and opening admits requests", (t) => {
  const { w, open, closed } = cast(t);
  ok(
    t,
    w.run("olga", "spaces.update", {
      id: open,
      set: {
        faq: true,
        topics: [
          ["a", "A"],
          ["b", "B"],
        ],
      },
    }),
  );
  const th = w.id();
  ok(t, w.run("mel", "threads.create", { id: th, space: open, kind: "ask", q: "Q", topic: "b" }));
  t.like(rec(w, `thread:${th}`, "thread"), { topic: "b", topicBy: "asker" });
  ok(
    t,
    w.run("olga", "spaces.update", {
      id: open,
      set: { topics: [["a", "A"]], rules: ["New rule"] },
    }),
  );
  t.is(rec(w, `thread:${th}`, "thread").topic, null);
  const s = rec(w, `space:${open}`, "space");
  t.like(s, { rulesRev: 1, rulesBy: "olga" });
  t.deepEqual(s.rulesPrev, ["Be specific in asks."]);
  // a save based on an older rules version is CONFLICT, unless forced
  refused(
    t,
    w.run("olga", "spaces.update", { id: open, set: { rules: ["x"] }, base: { rulesRev: 0 } }),
    "CONFLICT",
  );
  ok(
    t,
    w.run("olga", "spaces.update", {
      id: open,
      set: { rules: ["x"] },
      base: { rulesRev: 0 },
      force: true,
    }),
  );
  ok(t, w.run("olga", "spaces.update", { id: open, unset: ["faq", "topics"] }));
  t.like(rec(w, `space:${open}`, "space"), { faq: false });
  // a closed space that opens: open requests are approved, the banned are not admitted
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  ok(t, w.run("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  ok(t, w.run("mona", "members.ban", { space: closed, user: "otto" }));
  const mid = w.id();
  ok(t, w.run("olga", "spaces.update", { id: closed, set: { vis: "open" } }, mid));
  t.is(rec(w, `member:${closed}:eve`, "member").adm, deriveId("olga", mid, 1));
  t.is(w.get(`member:${closed}:otto`), undefined);
  t.like(rec(w, `request:${closed}:otto`, "request"), { st: "approved" });
  // `dom` and `pages` are not settings
  refused(t, w.run("olga", "spaces.update", { id: open, set: { dom: null } }), "BAD_REQUEST");
});

test("spaces.join: open spaces, live invite links only, a new admission id each time", (t) => {
  const { w, open, closed } = cast(t);
  refused(t, w.run("eve", "spaces.join", { space: closed }), "FORBIDDEN");
  const link = w.id();
  ok(t, w.run("mel", "invites.create", { id: link, space: closed, days: 1 }));
  const code = rec(w, `invite:${link}`, "invite").code;
  // revoked, then restored
  ok(t, w.run("mel", "invites.revoke", { id: link }));
  refused(t, w.run("eve", "spaces.join", { space: closed, invite: code }), "FORBIDDEN");
  ok(t, w.run("mel", "invites.restore", { id: link }));
  // expired
  const later = new World(1);
  void later;
  w.advance(2 * DAY);
  refused(t, w.run("eve", "spaces.join", { space: closed, invite: code }), "FORBIDDEN");
  const fresh = w.id();
  ok(t, w.run("mel", "invites.create", { id: fresh, space: closed }));
  const mid = w.id();
  ok(
    t,
    w.run(
      "eve",
      "spaces.join",
      { space: closed, invite: rec(w, `invite:${fresh}`, "invite").code },
      mid,
    ),
  );
  t.like(rec(w, `invite:${fresh}`, "invite"), { dead: "Used", usedBy: "eve" });
  t.is(rec(w, `member:${closed}:eve`, "member").adm, deriveId("eve", mid, 1));
  // the link is used up
  ok(t, w.run("eve", "spaces.leave", { space: closed }));
  refused(
    t,
    w.run("eve", "spaces.join", {
      space: closed,
      invite: rec(w, `invite:${fresh}`, "invite").code,
    }),
    "FORBIDDEN",
  );
  // joining an open space again gives a new admission id
  ok(t, w.run("eve", "spaces.join", { space: open }));
  const a1 = rec(w, `member:${open}:eve`, "member").adm;
  ok(t, w.run("eve", "spaces.leave", { space: open }));
  ok(t, w.run("eve", "spaces.join", { space: open }));
  t.not(rec(w, `member:${open}:eve`, "member").adm, a1);
  // the sole owner cannot leave
  refused(t, w.run("olga", "spaces.leave", { space: open }), "PRECONDITION_FAILED");
});

test("spaces.join with an invite notification marks it accepted and does not admit", (t) => {
  const { w, vault } = cast(t);
  const n = w.id();
  w.store.records.set(`notif:${n}`, {
    kind: "notif",
    id: n,
    to: "eve",
    type: "invite",
    sp: vault,
    report: null,
    item: null,
    outcome: null,
    response: null,
    actor: "olga",
    thread: null,
    node: null,
    invite: null,
    read: false,
    createdAt: "2026-11-15T00:00:00Z",
    rev: 1,
  });
  refused(t, w.run("eve", "spaces.join", { space: vault, notification: n }), "FORBIDDEN");
  refused(t, w.run("mel", "spaces.join", { space: vault, notification: n }), "NOT_FOUND");
  ok(t, w.run("eve", "invites.decline", { notification: n }));
  t.like(rec(w, `notif:${n}`, "notif"), { read: true, response: "declined" });
});

test("spaces.verifyDomain, spaces.archive and spaces.delete", (t) => {
  const { w, open, closed } = cast(t);
  const th = thread(t, w, "mel", open, "post");
  ok(t, w.run("otto", "likes.set", { thread: th, on: true }));
  ok(t, w.run("otto", "saved.set", { kind: "thread", id: th, on: true }));
  const out = w.run("olga", "spaces.verifyDomain", { id: open, domain: " Example.ORG " });
  ok(t, out);
  t.deepEqual(out.status === "ok" ? out.effects : null, [
    { type: "job", kind: "domain", id: open },
  ]);
  t.deepEqual(rec(w, `space:${open}`, "space").dom, {
    domain: "example.org",
    method: "dns",
    state: "checking",
    verifiedAt: null,
  });
  refused(t, w.run("olga", "spaces.verifyDomain", { id: open, domain: "nope" }), "BAD_REQUEST");
  ok(t, w.run("olga", "spaces.archive", { id: open, archived: true }));
  t.deepEqual(rec(w, `space:${open}`, "space").archived, {
    by: "olga",
    at: "2026-11-16T10:00:00Z",
  });
  refused(
    t,
    w.run("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "x" }),
    "PRECONDITION_FAILED",
  );
  refused(
    t,
    w.run("mel", "research.createPostFollowUp", { id: w.id(), thread: th, t: "x" }),
    "PRECONDITION_FAILED",
  );
  ok(t, w.run("olga", "spaces.archive", { id: open, archived: false }));
  // delete: online, owner only, erases the content and the marks on it
  ok(t, w.run("olga", "spaces.delete", { id: open }));
  const left = [...w.store.records.values()].filter(
    (r) => r.kind !== "space" && JSON.stringify(r).includes(open),
  );
  t.deepEqual(left, []);
  t.is(w.get(`like:otto:${th}`), undefined);
  t.like(rec(w, `space:${open}`, "space"), { deleted: true, members: 0 });
  refused(t, w.run("mel", "spaces.join", { space: open }), "NOT_FOUND");
  refused(t, w.run("eve", "spaces.create", { id: w.id(), name: "lounge" }), "CONFLICT");
  t.truthy(w.get(`space:${closed}`));
});

test("onboarding.finish joins open spaces only, each with its own admission id", (t) => {
  const { w, open, closed } = cast(t);
  const other = w.id();
  ok(t, w.run("olga", "spaces.create", { id: other, name: "other" }));
  refused(t, w.run("eve", "onboarding.finish", { spaces: [open, closed] }), "FORBIDDEN");
  const mid = w.id();
  ok(t, w.run("eve", "onboarding.finish", { spaces: [open, other, open] }, mid));
  t.is(rec(w, `member:${open}:eve`, "member").adm, deriveId("eve", mid, 1));
  t.is(rec(w, `member:${other}:eve`, "member").adm, deriveId("eve", mid, 2));
  t.is(rec(w, `space:${other}`, "space").members, 2);
});

// ---- threads ----

test("threads.create: counts, stats, a run with a derived id and its job; payers and posts off", (t) => {
  const { w, open } = cast(t);
  w.key("mel", "K");
  const id = w.id();
  const mid = w.id();
  const out = w.run(
    "mel",
    "threads.create",
    { id, space: open, kind: "ask", q: " Q ", pay: "K", model: "m" },
    mid,
  );
  const run = deriveId("mel", mid, 1);
  t.deepEqual(ok(t, out), { id, run });
  t.deepEqual(out.status === "ok" ? out.effects : null, [{ type: "job", kind: "run", id: run }]);
  t.like(rec(w, `thread:${id}`, "thread"), {
    q: "Q",
    running: true,
    att: 1,
    pay: "K",
    model: "m",
    u: "mel",
  });
  t.like(rec(w, `run:${run}`, "run"), { th: id, attempt: 1, pay: "K", u: "mel" });
  t.like(rec(w, `counts:${id}`, "counts"), { likes: 0, r: 0 });
  t.is(rec(w, `stats:${open}`, "stats").posts, 1);
  // a key that pays must be the asker's (its record, in `can`)
  refused(
    t,
    w.run("otto", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x", pay: "K" }),
    "FORBIDDEN",
  );
  ok(
    t,
    w.run("otto", "threads.create", {
      id: w.id(),
      space: open,
      kind: "ask",
      q: "x",
      pay: "session",
    }),
  );
  ok(t, w.run("olga", "spaces.update", { id: open, set: { postsOff: true } }));
  refused(
    t,
    w.run("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "x" }),
    "PRECONDITION_FAILED",
  );
  refused(
    t,
    w.run("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "  " }),
    "BAD_REQUEST",
  );
  // a derived id that is taken: CONFLICT, nothing written
  const mid2 = w.id();
  w.store.registry.set(deriveId("mel", mid2, 1), 1);
  const before = w.store.records.size;
  refused(
    t,
    w.run("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x" }, mid2),
    "CONFLICT",
  );
  t.is(w.store.records.size, before);
});

test("threads.create from a branch: the asker's own follow-up, copied with the asks below it", (t) => {
  const { w, open, closed } = cast(t);
  const th = thread(t, w, "mel", open);
  const [a, b, c, d] = [w.id(), w.id(), w.id(), w.id()];
  ok(t, w.run("otto", "followups.ask", { id: a, thread: th, q: "A" }));
  ok(t, w.run("mel", "research.forkNode", { id: b, thread: th, parent: a, q: "B" }));
  ok(t, w.run("mel", "research.forkNode", { id: c, thread: th, parent: b, q: "C" }));
  ok(t, w.run("mel", "research.forkNode", { id: d, thread: th, parent: b, q: "D" }));
  ok(t, w.run("mona", "moderation.decide", { item: `f:${th}:${d}`, decision: "hidden" }));
  refused(
    t,
    w.run("otto", "threads.create", {
      id: w.id(),
      space: open,
      kind: "ask",
      q: "",
      from: { th, node: b },
    }),
    "FORBIDDEN",
  );
  const id = w.id();
  const mid = w.id();
  ok(
    t,
    w.run(
      "mel",
      "threads.create",
      { id, space: open, kind: "ask", q: "", from: { th, node: b }, branch: "all" },
      mid,
    ),
  );
  t.like(rec(w, `thread:${id}`, "thread"), { u: "mel", q: "B", t: "B", running: false });
  t.deepEqual(rec(w, `thread:${id}`, "thread").from, { th, node: b, lv: 2 });
  t.is(rec(w, `followup:${b}`, "followup").promoted, id);
  // c is copied with a derived id; the hidden d is not
  const copy = rec(w, `followup:${deriveId("mel", mid, 1)}`, "followup");
  t.like(copy, { th: id, par: null, u: "mel", q: "C" });
  t.is(w.get(`followup:${deriveId("mel", mid, 2)}`), undefined);
  t.is(rec(w, `counts:${id}`, "counts").r, 1);
  // a branch of a closed space's thread stays in that space
  const cth = thread(t, w, "mel", closed);
  const cf = w.id();
  ok(t, w.run("mel", "followups.ask", { id: cf, thread: cth, q: "F" }));
  refused(
    t,
    w.run("mel", "threads.create", {
      id: w.id(),
      space: open,
      kind: "ask",
      q: "",
      from: { th: cth, node: cf },
    }),
    "FORBIDDEN",
  );
  refused(
    t,
    w.run("mel", "threads.create", {
      id: w.id(),
      space: open,
      kind: "ask",
      q: "",
      from: { th, node: "r" },
    }),
    "BAD_REQUEST",
  );
});

test("threads.update: STALE on an old rev, a run again with a new run, and the deleted and removed refuse", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  refused(t, w.run("mel", "threads.update", { id: th, q: "x", base: { rev: 0 } }), "STALE");
  ok(t, w.run("mel", "threads.update", { id: th, q: "Q2", base: { rev: 1 } }));
  t.like(rec(w, `thread:${th}`, "thread"), { q: "Q2", edited: true });
  const mid = w.id();
  const out = w.run(
    "mel",
    "threads.update",
    { id: th, q: "Q2", run: true, model: "m2", base: { rev: 2 } },
    mid,
  );
  t.deepEqual(ok(t, out), { run: deriveId("mel", mid, 1) });
  t.deepEqual(out.status === "ok" ? out.effects : null, [
    { type: "job", kind: "run", id: deriveId("mel", mid, 1) },
  ]);
  t.like(rec(w, `thread:${th}`, "thread"), { att: 2, running: true, model: "m2", sum: null });
  t.like(rec(w, `run:${deriveId("mel", mid, 1)}`, "run"), { attempt: 2 });
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  refused(
    t,
    w.run("mel", "threads.update", { id: th, q: "x", base: { rev: w.rev(`thread:${th}`) } }),
    "PRECONDITION_FAILED",
  );
});

test("threads.delete: kept with follow-ups, gone without (and out of likes and saves); a removed member may delete", (t) => {
  const { w, open, closed } = cast(t);
  const a = thread(t, w, "mel", open);
  ok(t, w.run("otto", "followups.ask", { id: w.id(), thread: a, q: "F" }));
  ok(t, w.run("otto", "likes.set", { thread: a, on: true }));
  t.deepEqual(ok(t, w.run("mel", "threads.delete", { id: a })), { kept: true });
  t.like(rec(w, `thread:${a}`, "thread"), { del: true, gone: false, q: "" });
  t.truthy(w.get(`like:otto:${a}`));
  const b = thread(t, w, "mel", open, "post");
  ok(t, w.run("otto", "saved.set", { kind: "thread", id: b, on: true }));
  t.deepEqual(ok(t, w.run("mel", "threads.delete", { id: b })), { kept: false });
  t.like(rec(w, `thread:${b}`, "thread"), { gone: true });
  t.is(w.get(`save:otto:${b}`), undefined);
  // removed from the closed space: the author still deletes, and learns nothing
  const c = thread(t, w, "mel", closed);
  ok(
    t,
    w.run("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  t.is(ok(t, w.run("mel", "threads.delete", { id: c })), null);
});

test("threads.move: a moderator moves a thread to a topic of its space", (t) => {
  const { w, open } = cast(t);
  ok(t, w.run("olga", "spaces.update", { id: open, set: { faq: true, topics: [["t", "T"]] } }));
  const th = thread(t, w, "mel", open);
  ok(t, w.run("mona", "threads.move", { id: th, topic: "t" }));
  t.like(rec(w, `thread:${th}`, "thread"), { topic: "t", topicBy: "mod" });
  refused(t, w.run("mona", "threads.move", { id: th, topic: "u" }), "NOT_FOUND");
  ok(t, w.run("mona", "threads.move", { id: th, topic: null }));
});

// ---- follow-ups and replies ----

test("follow-ups: asks about asks, counts of the first level, edits with base, and deletes", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const post = thread(t, w, "mel", open, "post");
  const [a, b] = [w.id(), w.id()];
  ok(t, w.run("otto", "followups.ask", { id: a, thread: th, q: "A" }));
  t.like(
    ok(t, w.run("otto", "research.forkNode", { id: b, thread: th, parent: a, q: "B", uses: [a] })),
    { id: b },
  );
  t.like(rec(w, `followup:${b}`, "followup"), { par: a, uses: [a], u: "otto" });
  t.is(rec(w, `counts:${th}`, "counts").r, 1);
  refused(
    t,
    w.run("otto", "research.forkNode", { id: w.id(), thread: th, parent: w.id(), q: "x" }),
    "NOT_FOUND",
  );
  refused(t, w.run("otto", "followups.ask", { id: w.id(), thread: post, q: "x" }), "BAD_REQUEST");
  refused(
    t,
    w.run("otto", "followups.update", { thread: th, node: a, q: "A2", base: { rev: 9 } }),
    "STALE",
  );
  ok(t, w.run("otto", "followups.update", { thread: th, node: a, q: "A2", base: { rev: 1 } }));
  t.like(rec(w, `followup:${a}`, "followup"), { q: "A2", edited: true, att: 1 });
  ok(
    t,
    w.run("otto", "followups.update", {
      thread: th,
      node: a,
      q: "A2",
      run: true,
      base: { rev: 2 },
    }),
  );
  t.like(rec(w, `followup:${a}`, "followup"), { att: 2, a: null });
  // a follow-up with asks below it stays as a shell
  t.deepEqual(ok(t, w.run("otto", "followups.delete", { thread: th, node: a })), { kept: true });
  t.like(rec(w, `followup:${a}`, "followup"), { del: true, q: "" });
  t.is(rec(w, `counts:${th}`, "counts").r, 1);
  refused(
    t,
    w.run("otto", "followups.update", {
      thread: th,
      node: a,
      q: "x",
      base: { rev: w.rev(`followup:${a}`) },
    }),
    "PRECONDITION_FAILED",
  );
  t.deepEqual(ok(t, w.run("otto", "followups.delete", { thread: th, node: b })), { kept: false });
  t.is(w.get(`followup:${b}`), undefined);
  const c = w.id();
  ok(t, w.run("otto", "followups.ask", { id: c, thread: th, q: "C" }));
  t.is(rec(w, `counts:${th}`, "counts").r, 2);
  ok(t, w.run("otto", "followups.delete", { thread: th, node: c }));
  t.is(rec(w, `counts:${th}`, "counts").r, 1);
});

test("replies: one level of nesting, edits with base, deletes that keep a top-level reply with replies", (t) => {
  const { w, open } = cast(t);
  const post = thread(t, w, "mel", open, "post");
  const [a, b] = [w.id(), w.id()];
  ok(t, w.run("otto", "research.createPostFollowUp", { id: a, thread: post, t: "A" }));
  ok(t, w.run("mel", "research.createPostFollowUp", { id: b, thread: post, t: "B", parent: a }));
  refused(
    t,
    w.run("mel", "research.createPostFollowUp", { id: w.id(), thread: post, t: "C", parent: b }),
    "NOT_FOUND",
  );
  t.is(rec(w, `counts:${post}`, "counts").r, 1);
  refused(
    t,
    w.run("otto", "replies.update", { thread: post, reply: a, t: "A2", base: { rev: 0 } }),
    "STALE",
  );
  ok(t, w.run("otto", "replies.update", { thread: post, reply: a, t: "A2", base: { rev: 1 } }));
  t.like(rec(w, `reply:${a}`, "reply"), { t: "A2", edited: true });
  ok(t, w.run("otto", "likes.setReply", { reply: b, on: true }));
  t.truthy(w.get(`rlike:otto:${b}`));
  t.deepEqual(ok(t, w.run("otto", "replies.delete", { thread: post, reply: a })), { kept: true });
  t.like(rec(w, `reply:${a}`, "reply"), { del: true, t: "" });
  t.deepEqual(ok(t, w.run("mel", "replies.delete", { thread: post, reply: b })), { kept: false });
  t.is(w.get(`rlike:otto:${b}`), undefined);
  t.is(rec(w, `counts:${post}`, "counts").r, 1);
});

// ---- likes and saves ----

test("likes and saves: required `on`, counts in the counts record, taking back needs no access", (t) => {
  const { w, open, closed } = cast(t);
  const th = thread(t, w, "mel", open);
  const rev = w.rev(`thread:${th}`);
  ok(t, w.run("otto", "likes.set", { thread: th, on: true }));
  ok(t, w.run("otto", "likes.set", { thread: th, on: true }));
  t.is(rec(w, `counts:${th}`, "counts").likes, 1);
  t.is(w.rev(`thread:${th}`), rev);
  ok(t, w.run("otto", "likes.set", { thread: th, on: false }));
  t.is(rec(w, `counts:${th}`, "counts").likes, 0);
  // a closed thread: eve may not like it, and may take back what she does not have
  const c = thread(t, w, "mel", closed);
  refused(t, w.run("eve", "likes.set", { thread: c, on: true }), "NOT_FOUND");
  t.deepEqual(ok(t, w.run("eve", "likes.set", { thread: c, on: false })), { on: false });
  // saves of a thread, of an ask and of a source
  ok(t, w.run("otto", "saved.set", { kind: "ask", id: `${th}:r`, on: true }));
  t.truthy(w.get(`asksave:otto:${th}:r`));
  refused(t, w.run("otto", "saved.set", { kind: "source", id: "S", on: true }), "NOT_FOUND");
  ok(t, w.run("otto", "saved.set", { kind: "source", id: "S", on: false }));
  refused(t, w.run("otto", "saved.set", { kind: "ask", id: th, on: true }), "BAD_REQUEST");
  // a removed thread takes no new likes
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  refused(t, w.run("mel", "likes.set", { thread: th, on: true }), "PRECONDITION_FAILED");
});

// ---- members ----

test("join requests: answers, rules, withdraw, decline without base, approve and reopen with it", (t) => {
  const { w, closed, vault } = cast(t);
  ok(t, w.run("olga", "spaces.update", { id: closed, set: { qs: [{ q: "Why?", req: true }] } }));
  refused(
    t,
    w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }),
    "BAD_REQUEST",
  );
  refused(t, w.run("eve", "joinRequests.create", { space: closed, answers: ["x"] }), "BAD_REQUEST");
  refused(
    t,
    w.run("eve", "joinRequests.create", { space: vault, rulesAccepted: true }),
    "PRECONDITION_FAILED",
  );
  ok(
    t,
    w.run("eve", "joinRequests.create", { space: closed, answers: ["x"], rulesAccepted: true }),
  );
  ok(t, w.run("eve", "joinRequests.withdraw", { space: closed }));
  t.is(w.get(`request:${closed}:eve`), undefined);
  ok(
    t,
    w.run("eve", "joinRequests.create", { space: closed, answers: ["x"], rulesAccepted: true }),
  );
  refused(
    t,
    w.run("mona", "joinRequests.decide", { space: closed, users: ["eve"], decision: "approve" }),
    "BAD_REQUEST",
  );
  const seen = w.requests(closed, ["eve"]);
  ok(
    t,
    w.run("mona", "joinRequests.decide", {
      space: closed,
      users: ["eve"],
      decision: "decline",
      why: " No ",
    }),
  );
  t.like(rec(w, `request:${closed}:eve`, "request"), { st: "declined", why: "No" });
  refused(
    t,
    w.run("mona", "joinRequests.decide", {
      space: closed,
      users: ["eve"],
      decision: "reopen",
      base: seen,
    }),
    "STALE",
  );
  ok(
    t,
    w.run("mona", "joinRequests.decide", {
      space: closed,
      users: ["eve"],
      decision: "reopen",
      base: w.requests(closed, ["eve"]),
    }),
  );
  const mid = w.id();
  ok(
    t,
    w.run(
      "mona",
      "joinRequests.decide",
      { space: closed, users: ["eve"], decision: "approve", base: w.requests(closed, ["eve"]) },
      mid,
    ),
  );
  t.is(rec(w, `member:${closed}:eve`, "member").adm, deriveId("mona", mid, 1));
  refused(
    t,
    w.run("mona", "joinRequests.decide", { space: closed, users: ["eve"], decision: "decline" }),
    "PRECONDITION_FAILED",
  );
});

test("members: setRole with base, ownership transfer, remove by admission id, ban and unban", (t) => {
  const { w, open, closed } = cast(t);
  refused(
    t,
    w.run("olga", "members.setRole", { space: open, user: "mel", role: "mod", base: { rev: 9 } }),
    "STALE",
  );
  ok(
    t,
    w.run("olga", "members.setRole", {
      space: open,
      user: "mel",
      role: "admin",
      base: { rev: w.rev(`member:${open}:mel`) },
    }),
  );
  refused(
    t,
    w.run("mel", "members.setRole", { space: open, user: "otto", role: "owner", base: { rev: 1 } }),
    "FORBIDDEN",
  );
  ok(
    t,
    w.run("olga", "members.setRole", {
      space: open,
      user: "mel",
      role: "owner",
      base: { rev: w.rev(`member:${open}:mel`) },
    }),
  );
  t.like(rec(w, `member:${open}:olga`, "member"), { role: "admin" });
  t.deepEqual(rec(w, `space:${open}`, "space").mods, [
    ["mel", "owner"],
    ["olga", "admin"],
    ["mona", "mod"],
  ]);
  // a removal decided before the person was let in again is STALE
  admit(t, w, closed, "otto");
  const old = w.admission(closed, "otto");
  ok(t, w.run("otto", "spaces.leave", { space: closed }));
  admit(t, w, closed, "otto");
  refused(t, w.run("mona", "members.remove", { space: closed, user: "otto", base: old }), "STALE");
  ok(
    t,
    w.run("mona", "members.remove", {
      space: closed,
      user: "otto",
      base: w.admission(closed, "otto"),
    }),
  );
  t.is(ok(t, w.run("mona", "members.remove", { space: closed, user: "otto", base: old })), null);
  // an open space: remove works too (joining again undoes it)
  ok(
    t,
    w.run("mona", "members.remove", { space: open, user: "otto", base: w.admission(open, "otto") }),
  );
  t.is(w.get(`member:${open}:otto`), undefined);
  ok(t, w.run("mona", "members.ban", { space: closed, user: "mel" }));
  t.is(w.get(`member:${closed}:mel`), undefined);
  t.truthy(w.get(`ban:${closed}:mel`));
  refused(
    t,
    w.run("mel", "joinRequests.create", { space: closed, rulesAccepted: true }),
    "FORBIDDEN",
  );
  ok(t, w.run("mona", "members.unban", { space: closed, user: "mel" }));
  refused(t, w.run("mona", "members.unban", { space: closed, user: "mel" }), "NOT_FOUND");
  refused(t, w.run("mona", "members.ban", { space: closed, user: "olga" }), "FORBIDDEN");
});

test("invites: a code from the server's pre-check, bounded days, revoke and restore, asks for an invite", (t) => {
  const { w, open, closed, vault } = cast(t);
  const id = w.id();
  const out = w.run("mel", "invites.create", { id, space: closed, days: 30 });
  const r = ok(t, out) as { code: string };
  t.regex(r.code, /^[0-9a-hjkmnp-tv-z]{10}$/);
  t.is(rec(w, `invite:${id}`, "invite").expiresAt, "2026-12-16T10:00:00Z");
  refused(
    t,
    w.run("mel", "invites.create", { id: w.id(), space: closed, days: 31 }),
    "BAD_REQUEST",
  );
  refused(t, w.run("mel", "invites.create", { id: w.id(), space: vault }), "FORBIDDEN");
  // days: null (the dialog's "Never") never expires; 0 is no number of days
  const never = w.id();
  ok(t, w.run("mel", "invites.create", { id: never, space: closed, days: null }));
  t.is(rec(w, `invite:${never}`, "invite").expiresAt, null);
  refused(t, w.run("mel", "invites.create", { id: w.id(), space: closed, days: 0 }), "BAD_REQUEST");
  ok(t, w.run("mona", "invites.revoke", { id }));
  refused(t, w.run("mona", "invites.revoke", { id }), "NOT_FOUND");
  // a moderator revoked mel's link: mel, a member, cannot restore it
  t.is(rec(w, `invite:${id}`, "invite").revokedRole, "mod");
  refused(t, w.run("mel", "invites.restore", { id }), "FORBIDDEN");
  ok(t, w.run("mona", "invites.restore", { id }));
  refused(t, w.run("mona", "invites.restore", { id }), "NOT_FOUND");
  // a link its maker revoked as a member, the maker restores
  ok(t, w.run("mel", "invites.revoke", { id }));
  t.is(rec(w, `invite:${id}`, "invite").revokedRole, null);
  ok(t, w.run("mel", "invites.restore", { id }));
  // an open space takes no invite asks
  refused(t, w.run("eve", "invites.request", { space: open }), "BAD_REQUEST");
  ok(t, w.run("eve", "invites.request", { space: vault }));
  ok(t, w.run("eve", "invites.request", { space: vault }));
  t.truthy(w.get(`invask:eve:${vault}`));
  // the code is the server's: a client predicting the write gets `unknown`
  t.true(MUTATORS.get("invites.create")?.needsPre({}) === true);
});

// ---- reports and moderation ----

test("reports: staff notified, resolutions resolve every open report on the item and tell their authors", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const [r1, r2] = [w.id(), w.id()];
  const out = w.run("otto", "reports.create", {
    id: r1,
    item: `a:${th}`,
    why: " Spam ",
    note: " n ",
  });
  t.deepEqual(ok(t, out), { id: r1, sp: open });
  t.deepEqual(out.status === "ok" ? out.effects : null, [
    { type: "notifyStaff", sp: open, report: r1, item: `a:${th}` },
  ]);
  t.like(rec(w, `report:${r1}`, "report"), { why: "Spam", note: "n", st: "open", by: "otto" });
  ok(t, w.run("eve", "reports.create", { id: r2, item: `a:${th}`, why: "x" }));
  const hid = w.run("mona", "reports.resolve", { report: r1, outcome: "hidden" });
  ok(t, hid);
  t.deepEqual(hid.status === "ok" ? hid.effects : null, [
    { type: "reportResolved", report: r1, outcome: "hidden" },
    { type: "reportResolved", report: r2, outcome: "hidden" },
  ]);
  t.truthy(w.get(`hide:thread:${th}`));
  t.like(rec(w, `report:${r2}`, "report"), { st: "hidden" });
  // reopening: base is the report's rev and the hide record's; the last
  // resolved report shows the item, when the hide record's rev matches
  const both = (r: string) => ({ rev: w.rev(`report:${r}`), item: w.rev(`hide:thread:${th}`) });
  ok(t, w.run("mona", "reports.resolve", { report: r2, outcome: "open", base: both(r2) }));
  t.truthy(w.get(`hide:thread:${th}`));
  ok(
    t,
    w.run("mel", "threads.update", { id: th, q: "edited", base: { rev: w.rev(`thread:${th}`) } }),
  );
  refused(
    t,
    w.run("mona", "reports.resolve", {
      report: r1,
      outcome: "open",
      base: { rev: w.rev(`report:${r1}`), item: 1 },
    }),
    "STALE",
  );
  refused(t, w.run("mona", "reports.resolve", { report: r1, outcome: "open" }), "BAD_REQUEST");
  const open1 = w.run("mona", "reports.resolve", { report: r1, outcome: "open", base: both(r1) });
  ok(t, open1);
  t.deepEqual(open1.status === "ok" ? open1.effects : null, [
    { type: "reportResolved", report: r1, outcome: null },
  ]);
  t.falsy(w.get(`hide:thread:${th}`));
  t.is(rec(w, `thread:${th}`, "thread").mod, null);
  // dismissing leaves the item as it is
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  ok(t, w.run("mona", "reports.resolve", { report: r1, outcome: "dismissed" }));
  t.truthy(w.get(`hide:thread:${th}`));
  // removed: erased; a removed item stays removed
  ok(t, w.run("mona", "reports.resolve", { report: r2, outcome: "removed" }));
  t.like(rec(w, `thread:${th}`, "thread"), { mod: "removed", q: "" });
  refused(
    t,
    w.run("mona", "reports.resolve", { report: r1, outcome: "hidden" }),
    "PRECONDITION_FAILED",
  );
});

test("moderation.decide: base required and compared for shown only; removal erases the thread's children", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const f = w.id();
  ok(t, w.run("otto", "followups.ask", { id: f, thread: th, q: "F" }));
  ok(
    t,
    w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden", base: { rev: 0 } }),
  );
  refused(
    t,
    w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }),
    "PRECONDITION_FAILED",
  );
  refused(
    t,
    w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "shown" }),
    "BAD_REQUEST",
  );
  refused(
    t,
    w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "shown", base: { rev: 2 } }),
    "STALE",
  );
  // hiding left the thread as it was: its rev is the one before the hide
  t.is(w.rev(`thread:${th}`), 1);
  ok(
    t,
    w.run("mona", "moderation.decide", {
      item: `a:${th}`,
      decision: "shown",
      base: { rev: w.rev(`hide:thread:${th}`) },
    }),
  );
  t.is(w.get(`hide:thread:${th}`), undefined);
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.is(w.get(`followup:${f}`), undefined);
  t.is(rec(w, `counts:${th}`, "counts").r, 0);
  refused(
    t,
    w.run("mona", "moderation.decide", { item: `p:${th}`, decision: "hidden" }),
    "NOT_FOUND",
  );
});

// ---- personal ----

test("personal records: mutes, blocks, read sources, profile, notifications and the moderators' notices", (t) => {
  const { w, open } = cast(t);
  ok(t, w.run("otto", "mutes.set", { handle: "eve", on: true }));
  ok(t, w.run("otto", "blocks.set", { handle: "eve", on: true }));
  t.truthy(w.get("mute:otto:eve"));
  t.truthy(w.get("block:otto:eve"));
  ok(t, w.run("otto", "mutes.set", { handle: "eve", on: false }));
  t.is(w.get("mute:otto:eve"), undefined);
  ok(t, w.run("otto", "profile.update", { name: " Otto ", bio: " b " }));
  t.like(rec(w, "profile:otto", "profile"), { name: "Otto", bio: "b" });
  refused(t, w.run("otto", "profile.update", { name: "  ", bio: "" }), "BAD_REQUEST");
  const { id } = ok(t, w.run("mel", "spaceSources.add", { space: open, url: "example.org/x" })) as {
    id: string;
  };
  refused(
    t,
    w.run("otto", "spaceSources.add", { space: open, url: "https://example.org/x/" }),
    "PRECONDITION_FAILED",
  );
  ok(t, w.run("otto", "sources.markRead", { id }));
  ok(t, w.run("otto", "sources.markRead", { id }));
  t.truthy(w.get(`srcread:otto:${id}`));
  refused(t, w.run("otto", "sources.markRead", { id: "nope" }), "NOT_FOUND");
  // the notices are for moderators: of a closed space, for requests
  refused(t, w.run("otto", "notifications.markSeen", { kind: "reports" }), "FORBIDDEN");
  ok(
    t,
    w.run("olga", "members.setRole", {
      space: open,
      user: "otto",
      role: "mod",
      base: { rev: w.rev(`member:${open}:otto`) },
    }),
  );
  refused(t, w.run("otto", "notifications.markSeen", { kind: "requests" }), "FORBIDDEN");
  ok(t, w.run("mona", "notifications.markSeen", { kind: "reports" }));
  t.like(rec(w, "seen:mona", "seen"), { reps: true, reqs: false });
  ok(t, w.run("mona", "notifications.markAllRead", {}));
  t.like(rec(w, "seen:mona", "seen"), { reps: true, reqs: true });
});

// ---- skills, pages and sources ----

test("skills: ids, names unique, versions and conflicts, remove by id, reorder by the whole order", (t) => {
  const { w, open } = cast(t);
  const [a, b] = [w.id(), w.id()];
  t.deepEqual(
    ok(t, w.run("mona", "skills.create", { id: a, space: open, name: "A", prompt: "a" })),
    { id: a },
  );
  ok(t, w.run("mona", "skills.create", { id: b, space: open, name: "B", prompt: "b" }));
  refused(
    t,
    w.run("mona", "skills.create", { id: w.id(), space: open, name: "A", prompt: "x" }),
    "CONFLICT",
  );
  refused(
    t,
    w.run("mona", "skills.create", { id: a, space: open, name: "C", prompt: "x" }),
    "CONFLICT",
  );
  ok(
    t,
    w.run("mona", "skills.update", {
      space: open,
      id: a,
      name: "A",
      prompt: "a2",
      base: { rev: 0 },
    }),
  );
  refused(
    t,
    w.run("mona", "skills.update", {
      space: open,
      id: a,
      name: "A",
      prompt: "a3",
      base: { rev: 0 },
    }),
    "CONFLICT",
  );
  ok(
    t,
    w.run("mona", "skills.update", {
      space: open,
      id: a,
      name: "A",
      prompt: "a3",
      base: { rev: 0 },
      force: true,
    }),
  );
  refused(
    t,
    w.run("mona", "skills.update", { space: open, id: a, name: "B", prompt: "x" }),
    "CONFLICT",
  );
  const rev = w.rev(`skills:${open}`);
  refused(
    t,
    w.run("mona", "skills.reorder", { space: open, order: [b, a], base: { rev: rev - 1 } }),
    "STALE",
  );
  refused(
    t,
    w.run("mona", "skills.reorder", { space: open, order: [b], base: { rev } }),
    "BAD_REQUEST",
  );
  refused(
    t,
    w.run("mona", "skills.reorder", { space: open, order: [b, b], base: { rev } }),
    "BAD_REQUEST",
  );
  ok(t, w.run("mona", "skills.reorder", { space: open, order: [b, a], base: { rev } }));
  t.deepEqual(rec(w, `skills:${open}`, "skills").order, [b, a]);
  t.like(rec(w, `skill:${b}`, "skill"), { sp: open, name: "B", prompt: "b", ver: 0 });
  t.like(rec(w, `skill:${a}`, "skill"), { sp: open, name: "A", prompt: "a3", ver: 2 });
  ok(t, w.run("mona", "skills.remove", { space: open, id: b }));
  refused(t, w.run("mona", "skills.remove", { space: open, id: b }), "NOT_FOUND");
  refused(
    t,
    w.run("mona", "skills.update", { space: open, id: b, name: "B", prompt: "x" }),
    "NOT_FOUND",
  );
});

test("pages: create with an id, edit with versions and a new title, restore, move, remove; slugs unique; pageEdit decides who edits", (t) => {
  const { w, open } = cast(t);
  const [g, f] = [w.id(), w.id()];
  refused(
    t,
    w.run("mel", "pages.update", { space: open, id: w.id(), title: "G", text: [] }),
    "FORBIDDEN",
  );
  refused(t, w.run("mona", "pages.update", { space: open, title: "G", text: [] }), "BAD_REQUEST");
  t.deepEqual(
    ok(t, w.run("mona", "pages.update", { space: open, id: g, title: "Guide", text: [] })),
    { id: g },
  );
  t.like(rec(w, `page:${g}`, "page"), { ver: 1, by: "mona", text: [""], slug: "guide", sp: open });
  // a title whose slug another page has: CONFLICT
  refused(
    t,
    w.run("mona", "pages.update", { space: open, id: w.id(), title: "guide!", text: [] }),
    "CONFLICT",
  );
  refused(
    t,
    w.run("mona", "pages.update", { space: open, id: w.id(), title: "???", text: [] }),
    "BAD_REQUEST",
  );
  ok(t, w.run("olga", "spaces.update", { id: open, set: { pageEdit: "members" } }));
  ok(
    t,
    w.run("mel", "pages.update", {
      space: open,
      page: g,
      title: "New Guide",
      text: ["x"],
      base: { rev: 1 },
    }),
  );
  const doc = rec(w, `page:${g}`, "page");
  t.like(doc, { ver: 2, by: "mona", ed: "mel", slug: "new-guide", t: "New Guide" });
  t.deepEqual(
    doc.revs.map((r) => r.note),
    ["Edited the page", "Created the page"],
  );
  refused(
    t,
    w.run("mona", "pages.update", { space: open, page: g, title: "X", text: [], base: { rev: 1 } }),
    "CONFLICT",
  );
  ok(
    t,
    w.run("mel", "pages.restore", {
      space: open,
      page: g,
      rev: 1,
      note: "Restored",
      base: { rev: 2 },
    }),
  );
  t.is(rec(w, `page:${g}`, "page").ver, 3);
  refused(
    t,
    w.run("mel", "pages.restore", { space: open, page: g, rev: 7, note: "x" }),
    "NOT_FOUND",
  );
  ok(t, w.run("mona", "pages.update", { space: open, id: f, title: "FAQ", text: ["f"] }));
  refused(
    t,
    w.run("mona", "pages.update", { space: open, page: f, title: "New guide", text: [] }),
    "CONFLICT",
  );
  ok(t, w.run("mona", "pages.move", { space: open, page: f, to: 0 }));
  t.deepEqual(
    rec(w, `pages:${open}`, "pages").list.map((p) => [p.id, p.t]),
    [
      [f, "FAQ"],
      [g, "New Guide"],
    ],
  );
  ok(t, w.run("mona", "pages.remove", { space: open, page: g }));
  t.is(w.get(`page:${g}`), undefined);
  refused(t, w.run("mona", "pages.remove", { space: open, page: g }), "NOT_FOUND");
  refused(t, w.run("mel", "pages.remove", { space: open, page: f }), "FORBIDDEN");
});

test("sources: added by URL with a derived id, a known URL reused, review policy, reports and review", (t) => {
  const { w, open, closed } = cast(t);
  const mid = w.id();
  const out = ok(
    t,
    w.run(
      "mel",
      "spaceSources.add",
      { space: open, url: "https://www.arxiv.org/abs/1", note: " n " },
      mid,
    ),
  );
  const id = deriveId("mel", mid, 1);
  t.deepEqual(out, { id, review: false });
  const e = rec(w, `spacesrc:${open}:${id}`, "spacesrc");
  t.like(e, { by: "mel", note: "n", rv: false, rm: false, nurl: "arxiv.org/abs/1" });
  t.like(e.meta, { pl: "arxiv", form: "article", t: "1" });
  t.truthy(w.get(`srcread:mel:${id}`));
  refused(t, w.run("otto", "spaceSources.add", { space: open, source: id }), "PRECONDITION_FAILED");
  // the same URL in another space is the same source
  ok(t, w.run("mona", "spaceSources.setPolicy", { space: closed, policy: "review" }));
  t.deepEqual(ok(t, w.run("mel", "spaceSources.add", { space: closed, url: "arxiv.org/abs/1/" })), {
    id,
    review: true,
  });
  t.true(rec(w, `spacesrc:${closed}:${id}`, "spacesrc").rv);
  ok(t, w.run("mona", "spaceSources.review", { space: closed, source: id, decision: "approve" }));
  t.false(rec(w, `spacesrc:${closed}:${id}`, "spacesrc").rv);
  ok(t, w.run("mel", "sourceReports.create", { space: closed, source: id, why: "Broken" }));
  ok(t, w.run("mel", "sourceReports.create", { space: closed, source: id, why: "Still broken" }));
  t.like(rec(w, `srcrep:${closed}:${id}:mel`, "srcrep"), { why: "Still broken" });
  ok(t, w.run("mona", "spaceSources.review", { space: closed, source: id, decision: "keep" }));
  t.is(w.get(`srcrep:${closed}:${id}:mel`), undefined);
  ok(t, w.run("mona", "spaceSources.review", { space: closed, source: id, decision: "remove" }));
  refused(
    t,
    w.run("mona", "spaceSources.review", { space: closed, source: id, decision: "remove" }),
    "NOT_FOUND",
  );
  ok(t, w.run("mona", "spaceSources.review", { space: closed, source: id, decision: "restore" }));
  ok(t, w.run("mona", "spaceSources.setPolicy", { space: open, policy: "mods" }));
  refused(t, w.run("mel", "spaceSources.add", { space: open, file: "a.pdf" }), "FORBIDDEN");
  refused(t, w.run("mona", "spaceSources.add", { space: open }), "BAD_REQUEST");
  // a pending source's fields are for its adder and the moderators: another
  // member adding the same URL gets a new source
  admit(t, w, closed, "otto");
  const mid2 = w.id();
  ok(t, w.run("mel", "spaceSources.add", { space: closed, url: "example.org/pending" }, mid2));
  const mid3 = w.id();
  t.deepEqual(
    ok(t, w.run("otto", "spaceSources.add", { space: closed, url: "example.org/pending" }, mid3)),
    {
      id: deriveId("otto", mid3, 1),
      review: true,
    },
  );
});
