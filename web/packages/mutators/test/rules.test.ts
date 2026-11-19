// The rules every mutator shares, checked mutator by mutator:
// - a ban stops every write in its space (each space-scoped mutator applies
//   for its actor, and is FORBIDDEN once the actor is banned);
// - each mutator refuses an actor below the role it needs;
// - a missing target and one the actor may not read get the same answer;
// - a signed-out caller and an input with an extra field are refused.

import test from "ava";

import { MUTATORS, apply } from "../src/index.js";

import { World, ok, refused } from "./world.js";

/** A world for these tests:
 * - `open` (#lounge): owner olga, admin ada, moderator mona, members mel and otto;
 * - `closed` (#lab): owner olga, moderator mona, member mel;
 * - in `open`, mel's ask (with otto's follow-up), otto's post (with mel's
 *   reply), a report by otto, an invite link by mona, a page, a skill and
 *   a source; in `closed`, mel's ask, follow-up, post and reply, a report and
 *   a source. */
function world(t: Parameters<typeof ok>[0]) {
  const w = new World(3);
  const open = w.id();
  const closed = w.id();
  ok(t, w.run("olga", "spaces.create", { id: open, name: "lounge" }));
  ok(
    t,
    w.run("olga", "spaces.create", { id: closed, name: "lab", vis: "listed", invite: "members" }),
  );
  for (const u of ["ada", "mona", "mel", "otto"]) ok(t, w.run(u, "spaces.join", { space: open }));
  const role = (sp: string, u: string, r: string) =>
    ok(
      t,
      w.run("olga", "members.setRole", {
        space: sp,
        user: u,
        role: r,
        base: { rev: w.rev(`member:${sp}:${u}`) },
      }),
    );
  role(open, "ada", "admin");
  role(open, "mona", "mod");
  for (const u of ["mona", "mel"]) {
    ok(t, w.run(u, "joinRequests.create", { space: closed, rulesAccepted: true }));
    ok(
      t,
      w.run("olga", "joinRequests.decide", {
        space: closed,
        users: [u],
        decision: "approve",
        base: w.requests(closed, [u]),
      }),
    );
  }
  role(closed, "mona", "mod");
  const ids = {
    ask: w.id(),
    fu: w.id(),
    post: w.id(),
    reply: w.id(),
    report: w.id(),
    link: w.id(),
    cAsk: w.id(),
    cFu: w.id(),
    cPost: w.id(),
    cReply: w.id(),
    cReport: w.id(),
    page: w.id(),
    skill: w.id(),
  };
  ok(t, w.run("mel", "threads.create", { id: ids.ask, space: open, kind: "ask", q: "Q" }));
  ok(t, w.run("otto", "followups.ask", { id: ids.fu, thread: ids.ask, q: "F" }));
  ok(t, w.run("otto", "threads.create", { id: ids.post, space: open, kind: "post", q: "P" }));
  ok(t, w.run("mel", "research.createPostFollowUp", { id: ids.reply, thread: ids.post, t: "R" }));
  ok(t, w.run("otto", "reports.create", { id: ids.report, item: `a:${ids.ask}`, why: "W" }));
  ok(t, w.run("mona", "invites.create", { id: ids.link, space: open }));
  ok(t, w.run("mona", "pages.update", { space: open, id: ids.page, title: "Guide", text: ["x"] }));
  ok(t, w.run("mona", "skills.create", { id: ids.skill, space: open, name: "S", prompt: "p" }));
  ok(t, w.run("mel", "spaceSources.add", { space: open, url: "example.org/x" }));
  ok(t, w.run("mel", "threads.create", { id: ids.cAsk, space: closed, kind: "ask", q: "CQ" }));
  ok(t, w.run("mel", "followups.ask", { id: ids.cFu, thread: ids.cAsk, q: "CF" }));
  ok(t, w.run("mel", "threads.create", { id: ids.cPost, space: closed, kind: "post", q: "CP" }));
  ok(
    t,
    w.run("mel", "research.createPostFollowUp", { id: ids.cReply, thread: ids.cPost, t: "CR" }),
  );
  ok(t, w.run("mel", "reports.create", { id: ids.cReport, item: `a:${ids.cAsk}`, why: "W" }));
  ok(t, w.run("mel", "spaceSources.add", { space: closed, url: "example.org/closed" }));
  ok(t, w.run("ada", "spaces.update", { id: open, set: { faq: true, topics: [["t", "T"]] } }));
  ok(t, w.run("mona", "members.ban", { space: open, user: "eve" }));
  const src = (sp: string) =>
    [...w.store.records.values()].find((r) => r.kind === "spacesrc" && r.sp === sp) as {
      src: string;
    };
  return { w, open, closed, ids, src: src(open).src, cSrc: src(closed).src };
}

type World2 = ReturnType<typeof world>;
type Who = "user" | "member" | "moderator" | "admin" | "owner";
const ACTOR: Record<Who, string> = {
  user: "mel",
  member: "mel",
  moderator: "mona",
  admin: "ada",
  owner: "olga",
};

/** For each mutator that acts in a space: the role it needs, and a valid
 * input for that role's actor (`ACTOR`, or `AUTHOR`) in the open space, or
 * with "closed" in the closed one. */
const IN_OPEN: Record<string, [Who, (x: World2) => unknown, "closed"?]> = {
  "joinRequests.create": ["user", (x) => ({ space: x.closed, rulesAccepted: true }), "closed"],
  "followups.update": [
    "user",
    (x) => ({ thread: x.ids.ask, node: x.ids.fu, q: "F2", base: { rev: 1 } }),
  ],
  "followups.delete": ["user", (x) => ({ thread: x.ids.ask, node: x.ids.fu })],
  "spaces.update": ["admin", (x) => ({ id: x.open, set: { desc: "d" } })],
  "spaces.verifyDomain": ["admin", (x) => ({ id: x.open, domain: "example.org" })],
  "spaces.leave": ["member", (x) => ({ space: x.open })],
  "spaces.join": ["user", (x) => ({ space: x.open })],
  "threads.create": ["member", (x) => ({ id: x.w.id(), space: x.open, kind: "post", q: "q" })],
  "threads.update": [
    "user",
    (x) => ({ id: x.ids.ask, q: "Q2", base: { rev: x.w.rev(`thread:${x.ids.ask}`) } }),
  ],
  "threads.delete": ["user", (x) => ({ id: x.ids.ask })],
  "threads.move": ["moderator", (x) => ({ id: x.ids.ask, topic: "t" })],
  "likes.set": ["user", (x) => ({ thread: x.ids.ask, on: true })],
  "likes.setReply": ["user", (x) => ({ reply: x.ids.reply, on: true })],
  "saved.set": ["user", (x) => ({ kind: "thread", id: x.ids.ask, on: true })],
  "followups.ask": ["member", (x) => ({ id: x.w.id(), thread: x.ids.ask, q: "f" })],
  "research.forkNode": [
    "member",
    (x) => ({ id: x.w.id(), thread: x.ids.ask, parent: x.ids.fu, q: "f" }),
  ],
  "research.createPostFollowUp": ["member", (x) => ({ id: x.w.id(), thread: x.ids.post, t: "r" })],
  "replies.update": [
    "user",
    (x) => ({ thread: x.ids.post, reply: x.ids.reply, t: "r2", base: { rev: 1 } }),
  ],
  "replies.delete": ["user", (x) => ({ thread: x.ids.post, reply: x.ids.reply })],
  "joinRequests.withdraw": ["user", (x) => ({ space: x.open })],
  "joinRequests.decide": [
    "moderator",
    (x) => ({ space: x.closed, users: ["otto"], decision: "decline" }),
    "closed",
  ],
  "members.setRole": [
    "admin",
    (x) => ({
      space: x.open,
      user: "otto",
      role: "mod",
      base: { rev: x.w.rev(`member:${x.open}:otto`) },
    }),
  ],
  "members.remove": [
    "moderator",
    (x) => ({ space: x.closed, user: "mel", base: x.w.admission(x.closed, "mel") }),
    "closed",
  ],
  "members.ban": ["moderator", (x) => ({ space: x.open, user: "otto" })],
  "members.unban": ["moderator", (x) => ({ space: x.open, user: "eve" })],
  "invites.create": ["moderator", (x) => ({ id: x.w.id(), space: x.open })],
  "invites.revoke": ["moderator", (x) => ({ id: x.ids.link })],
  "invites.request": ["user", (x) => ({ space: x.open })],
  "reports.create": ["member", (x) => ({ id: x.w.id(), item: `p:${x.ids.post}`, why: "w" })],
  "reports.resolve": ["moderator", (x) => ({ report: x.ids.report, outcome: "dismissed" })],
  "moderation.decide": ["moderator", (x) => ({ item: `p:${x.ids.post}`, decision: "hidden" })],
  "skills.create": ["moderator", (x) => ({ id: x.w.id(), space: x.open, name: "S2", prompt: "p" })],
  "skills.update": [
    "moderator",
    (x) => ({ space: x.open, id: x.ids.skill, name: "S", prompt: "p2" }),
  ],
  "skills.remove": ["moderator", (x) => ({ space: x.open, id: x.ids.skill })],
  "skills.reorder": [
    "moderator",
    (x) => ({ space: x.open, order: [x.ids.skill], base: { rev: x.w.rev(`skills:${x.open}`) } }),
  ],
  "pages.update": [
    "moderator",
    (x) => ({ space: x.open, page: x.ids.page, title: "Guide", text: ["y"] }),
  ],
  "pages.restore": ["moderator", (x) => ({ space: x.open, page: x.ids.page, rev: 0, note: "n" })],
  "pages.remove": ["moderator", (x) => ({ space: x.open, page: x.ids.page })],
  "pages.move": ["moderator", (x) => ({ space: x.open, page: x.ids.page, other: x.ids.page })],
  "spaceSources.add": ["member", (x) => ({ space: x.open, url: "example.org/new" })],
  "spaceSources.review": [
    "moderator",
    (x) => ({ space: x.open, source: x.src, decision: "remove" }),
  ],
  "spaceSources.setPolicy": ["moderator", (x) => ({ space: x.open, policy: "review" })],
  "sourceReports.create": ["member", (x) => ({ space: x.open, source: x.src, why: "w" })],
  "onboarding.finish": ["user", (x) => ({ spaces: [x.open] })],
};

/** The space-scoped writes of a person's own threads and replies: the actor
 * is their author. */
const AUTHOR: Record<string, string> = {
  "joinRequests.create": "eve",
  "followups.update": "otto",
  "followups.delete": "otto",
  "threads.update": "mel",
  "threads.delete": "mel",
  "replies.update": "mel",
  "replies.delete": "mel",
};

/** Mutators that act in a space but cannot be tested with a ban: nobody can
 * ban the owner, and these need the owner; the creation of a space acts in
 * no space yet. Personal mutators act in no space. */
const NOT_BANNABLE = new Set(["spaces.archive", "spaces.delete", "spaces.create"]);
const PERSONAL = new Set([
  "mutes.set",
  "blocks.set",
  "sources.markRead",
  "profile.update",
  "notifications.markRead",
  "notifications.markAllRead",
  "notifications.markSeen",
  "invites.decline",
  "invites.restore",
]);

test("every mutator is listed here as space-scoped, owner-only or personal", (t) => {
  const listed = new Set([...Object.keys(IN_OPEN), ...NOT_BANNABLE, ...PERSONAL]);
  // invites.restore acts in the link's space; it is tested with revoke below
  t.deepEqual(
    MUTATORS.names.filter((n) => !listed.has(n)),
    [],
  );
});

test("a ban stops every write in its space, the author's own included", (t) => {
  const x = world(t);
  // otto asks to join the closed space, for the decision
  ok(t, x.w.run("otto", "joinRequests.create", { space: x.closed, rulesAccepted: true }));
  for (const [name, [who, input, where]] of Object.entries(IN_OPEN)) {
    const u = AUTHOR[name] ?? ACTOR[who];
    const sp = where === "closed" ? x.closed : x.open;
    const before = x.w.store.clone();
    const i = input(x);
    const out = apply(MUTATORS, before, { u }, envelope(x.w, name, i), {
      now: x.w.now,
      server: hooks,
    });
    t.is(out.status, "ok", `${name} as ${u} before the ban: ${JSON.stringify(out)}`);
    // the ban, by the owner, on a copy
    const banned = before.clone();
    const ban = apply(
      MUTATORS,
      banned,
      { u: "olga" },
      envelope(x.w, "members.ban", { space: sp, user: u }),
      {
        now: x.w.now,
        server: hooks,
      },
    );
    if (ban.status !== "ok") return t.fail(`ban ${u}: ${JSON.stringify(ban)}`);
    banned.commit(ban.writes);
    const after = apply(MUTATORS, banned, { u }, envelope(x.w, name, i), {
      now: x.w.now,
      server: hooks,
    });
    // a ban ends the membership, and with it a moderator's read access to
    // the space's links and reports: those are NOT_FOUND to them
    const want =
      name === "invites.revoke" || name === "reports.resolve" ? "NOT_FOUND" : "FORBIDDEN";
    refused(t, after, want, `${name} as ${u} after the ban`);
  }
  // restoring a link is in the link's space too
  ok(t, x.w.run("mona", "invites.revoke", { id: x.ids.link }));
  ok(t, x.w.run("olga", "members.ban", { space: x.open, user: "mona" }));
  refused(t, x.w.run("mona", "invites.restore", { id: x.ids.link }), "NOT_FOUND");
});

const hooks = { random: () => 0.5, ownsDevice: () => false };
const envelope = (w: World, name: string, input: unknown) => ({
  mutationId: w.id(),
  name,
  input,
  clientTime: w.now,
});

/** The role below the one a mutator needs, and who has it in the open space. */
const BELOW: Partial<Record<Who, string>> = { moderator: "mel", admin: "mona", owner: "ada" };

test("each mutator refuses an actor below the role it needs", (t) => {
  const x = world(t);
  for (const [name, [who, input, where]] of Object.entries(IN_OPEN)) {
    const u = BELOW[who];
    // a link or a report only its maker and the moderators may read is
    // NOT_FOUND to others
    if (u === undefined || where === "closed" || name === "invites.revoke") continue;
    if (name === "reports.resolve") continue;
    const out = apply(MUTATORS, x.w.store, { u }, envelope(x.w, name, input(x)), {
      now: x.w.now,
      server: hooks,
    });
    refused(t, out, "FORBIDDEN", `${name} as ${u}`);
  }
  refused(t, x.w.run("ada", "spaces.archive", { id: x.open, archived: true }), "FORBIDDEN");
  refused(t, x.w.run("ada", "spaces.delete", { id: x.open }), "FORBIDDEN");
  // in a closed space, "member" writes need a member; "user" writes a reader
  refused(
    t,
    x.w.run("otto", "threads.create", { id: x.w.id(), space: x.closed, kind: "post", q: "x" }),
    "FORBIDDEN",
  );
  refused(t, x.w.run("otto", "invites.create", { id: x.w.id(), space: x.closed }), "FORBIDDEN");
  ok(t, x.w.run("mel", "invites.create", { id: x.w.id(), space: x.closed }));
  // an author's writes: someone else's record is FORBIDDEN
  refused(
    t,
    x.w.run("otto", "threads.update", {
      id: x.ids.ask,
      q: "x",
      base: { rev: x.w.rev(`thread:${x.ids.ask}`) },
    }),
    "FORBIDDEN",
  );
  refused(t, x.w.run("otto", "threads.delete", { id: x.ids.ask }), "FORBIDDEN");
  refused(
    t,
    x.w.run("mel", "followups.update", {
      thread: x.ids.ask,
      node: x.ids.fu,
      q: "x",
      base: { rev: 1 },
    }),
    "FORBIDDEN",
  );
  refused(
    t,
    x.w.run("mel", "followups.delete", { thread: x.ids.ask, node: x.ids.fu }),
    "FORBIDDEN",
  );
  refused(
    t,
    x.w.run("otto", "replies.update", {
      thread: x.ids.post,
      reply: x.ids.reply,
      t: "x",
      base: { rev: 1 },
    }),
    "FORBIDDEN",
  );
  refused(
    t,
    x.w.run("otto", "replies.delete", { thread: x.ids.post, reply: x.ids.reply }),
    "FORBIDDEN",
  );
  // a link's maker or the space's moderators revoke it; to anyone else it
  // is a link they may not read
  refused(t, x.w.run("mel", "invites.revoke", { id: x.ids.link }), "NOT_FOUND");
  const mine = x.w.id();
  ok(t, x.w.run("mel", "invites.create", { id: mine, space: x.closed }));
  ok(t, x.w.run("mel", "invites.revoke", { id: mine }));
  ok(t, x.w.run("olga", "invites.restore", { id: mine }));
  refused(
    t,
    x.w.run("otto", "reports.resolve", { report: x.ids.report, outcome: "dismissed" }),
    "FORBIDDEN",
  );
  refused(
    t,
    x.w.run("mel", "joinRequests.decide", { space: x.closed, users: ["eve"], decision: "decline" }),
    "FORBIDDEN",
  );
  // the moderators' notices
  refused(t, x.w.run("otto", "notifications.markSeen", { kind: "reports" }), "FORBIDDEN");
});

/** For each mutator that names a record: an input naming the closed space's
 * record (which eve may not read) and one naming a record that does not
 * exist. */
const TARGETS: Record<string, (x: World2, id: (k: keyof World2["ids"]) => string) => unknown> = {
  "threads.update": (_x, id) => ({ id: id("cAsk"), q: "x", base: { rev: 1 } }),
  "threads.delete": (_x, id) => ({ id: id("cAsk") }),
  "threads.move": (_x, id) => ({ id: id("cAsk"), topic: null }),
  "likes.set": (_x, id) => ({ thread: id("cAsk"), on: true }),
  "likes.setReply": (_x, id) => ({ reply: id("cReply"), on: true }),
  "saved.set": (_x, id) => ({ kind: "thread", id: id("cAsk"), on: true }),
  "followups.ask": (_x, id) => ({ id: "01M7HWS780AAAAAAAAAAAAAAAA", thread: id("cAsk"), q: "x" }),
  "research.forkNode": (_x, id) => ({
    id: "01M7HWS780AAAAAAAAAAAAAAAB",
    thread: id("cAsk"),
    parent: "r",
    q: "x",
  }),
  "followups.update": (_x, id) => ({
    thread: id("cAsk"),
    node: id("cFu"),
    q: "x",
    base: { rev: 1 },
  }),
  "followups.delete": (_x, id) => ({ thread: id("cAsk"), node: id("cFu") }),
  "research.createPostFollowUp": (_x, id) => ({
    id: "01M7HWS780AAAAAAAAAAAAAAAC",
    thread: id("cPost"),
    t: "x",
  }),
  "replies.update": (_x, id) => ({
    thread: id("cPost"),
    reply: id("cReply"),
    t: "x",
    base: { rev: 1 },
  }),
  "replies.delete": (_x, id) => ({ thread: id("cPost"), reply: id("cReply") }),
  "reports.create": (_x, id) => ({
    id: "01M7HWS780AAAAAAAAAAAAAAAD",
    item: `a:${id("cAsk")}`,
    why: "x",
  }),
  "reports.resolve": (_x, id) => ({ report: id("cReport"), outcome: "dismissed" }),
  "moderation.decide": (_x, id) => ({ item: `a:${id("cAsk")}`, decision: "hidden" }),
};

test("a record the actor may not read gets the same answer as one that does not exist", (t) => {
  const x = world(t);
  const missing = x.w.id();
  for (const [name, input] of Object.entries(TARGETS)) {
    const hidden = x.w.run(
      "eve",
      name,
      input(x, (k) => x.ids[k]),
    );
    const absent = x.w.run(
      "eve",
      name,
      input(x, () => missing),
    );
    refused(t, hidden, "NOT_FOUND", `${name}, unreadable`);
    t.deepEqual(hidden, absent, name);
  }
  // sources: a closed space's source is unknown to eve
  for (const [name, input] of [
    ["sources.markRead", (id: string) => ({ id })],
    ["saved.set", (id: string) => ({ kind: "source", id, on: true })],
  ] as const) {
    const hidden = x.w.run("eve", name, input(x.cSrc));
    refused(t, hidden, "NOT_FOUND", name);
    t.deepEqual(hidden, x.w.run("eve", name, input("NOPE")), name);
  }
});

test("every mutator refuses a signed-out caller and an extra input field", (t) => {
  const x = world(t);
  for (const name of MUTATORS.names) {
    refused(t, x.w.run(null, name, {}), "UNAUTHORIZED", name);
    refused(t, x.w.run("eve", name, { forged: true }), "BAD_REQUEST", name);
  }
  for (const [name, [who, input]] of Object.entries(IN_OPEN)) {
    const i = input(x) as Record<string, unknown>;
    refused(
      t,
      x.w.run(AUTHOR[name] ?? ACTOR[who], name, { ...i, u: "olga", likes: 9 }),
      "BAD_REQUEST",
      name,
    );
  }
  refused(t, x.w.run("eve", "no.such", {}), "NOT_FOUND");
});
