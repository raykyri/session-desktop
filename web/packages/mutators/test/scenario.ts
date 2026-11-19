// A scripted history that calls every mutator, as several people, with
// writes that apply and writes that are refused. The determinism and
// prediction tests replay its steps; `every mutator` checks that each name
// applies at least once in it.

import type { ExecutionContext } from "ava";

import { DAY, admit, cast, thread, type World } from "./world.js";

/** Run the history in a recording world and return it. */
export function history(t: ExecutionContext, seed = 1): World {
  const { w, open, closed, vault } = cast(t, seed, true);
  const run = (u: string, name: string, input: unknown) => w.run(u, name, input);

  // a catalog source, written by the server (as a fixture)
  w.store.records.set("source:SRC1", {
    kind: "source",
    id: "SRC1",
    meta: {
      pl: "web",
      form: "article",
      au: "example.org",
      h: "example.org",
      len: "6 min read",
      tok: 2000,
      url: "example.org/a",
      t: "A",
      desc: "",
      sum: "",
      body: [],
    },
    nurl: "example.org/a",
    createdAt: "2026-11-01T00:00:00Z",
    rev: 1,
  });
  w.key("mel", "KEY1");
  w.device("mel", "MAC1");
  // notifications the server wrote: an invite to the vault for eve, and a
  // report notice for mona
  const invite = w.id();
  const notice = w.id();
  const rest = { report: null, item: null, outcome: null, response: null, actor: "olga" };
  const at = {
    thread: null,
    node: null,
    invite: null,
    read: false,
    createdAt: "2026-11-15T00:00:00Z",
    rev: 1,
  };
  w.store.records.set(`notif:${invite}`, {
    kind: "notif",
    id: invite,
    to: "eve",
    type: "invite",
    sp: vault,
    ...rest,
    ...at,
  });
  w.store.records.set(`notif:${notice}`, {
    kind: "notif",
    id: notice,
    to: "mona",
    type: "report",
    sp: open,
    ...rest,
    ...at,
  });
  w.store.registry.set(invite, 1);
  w.store.registry.set(notice, 1);

  // spaces
  run("olga", "spaces.update", {
    id: open,
    set: {
      desc: "Talk",
      faq: true,
      topics: [
        ["t1", "One"],
        ["t2", "Two"],
      ],
      av: 4,
      plain: true,
    },
  });
  run("olga", "spaces.update", { id: open, set: { rules: ["Be kind"] }, base: { rulesRev: 0 } });
  run("olga", "spaces.update", { id: open, set: { rules: ["x"] }, base: { rulesRev: 0 } });
  run("mona", "spaces.update", { id: open, set: { desc: "no" } });
  run("olga", "spaces.verifyDomain", { id: open, domain: "Example.org" });
  run("olga", "spaces.verifyDomain", { id: open, domain: "not a domain" });
  const extra = w.id();
  run("eve", "spaces.create", { id: extra, name: "#Eve's Place", vis: "listed" });
  run("eve", "spaces.create", { id: w.id(), name: "lounge" });
  run("eve", "spaces.archive", { id: extra, archived: true });
  run("eve", "spaces.archive", { id: extra, archived: false });
  run("olga", "spaces.archive", { id: extra, archived: true });
  run("otto", "onboarding.finish", { spaces: [open, extra] });
  run("otto", "onboarding.finish", { spaces: [open] });
  run("eve", "invites.request", { space: vault });

  // threads, follow-ups and replies
  const ask = w.id();
  run("mel", "threads.create", {
    id: ask,
    space: open,
    kind: "ask",
    q: "Why?",
    topic: "t1",
    pay: "KEY1",
    model: "m",
    about: { it: "SRC1" },
  });
  run("otto", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x", pay: "KEY1" });
  // device runs: mel's Mac, and a device that is not otto's
  const mac = { kind: "device", cli: "claude", device: "MAC1" };
  run("mel", "threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "On my Mac",
    executor: mac,
  });
  run("otto", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x", executor: mac });
  const post = thread(t, w, "otto", open, "post", "A post");
  const closedAsk = thread(t, w, "mel", closed, "ask", "In the lab");
  const f1 = w.id();
  run("otto", "followups.ask", { id: f1, thread: ask, q: "And then?" });
  const f2 = w.id();
  run("mel", "research.forkNode", {
    id: f2,
    thread: ask,
    parent: f1,
    q: "Deeper",
    uses: [f1],
    executor: mac,
  });
  const f3 = w.id();
  run("mel", "research.forkNode", { id: f3, thread: ask, parent: "r", q: "Sideways" });
  run("eve", "research.forkNode", { id: w.id(), thread: closedAsk, parent: "r", q: "no" });
  run("otto", "followups.update", {
    thread: ask,
    node: f1,
    q: "And then what?",
    base: { rev: w.rev(`followup:${f1}`) },
  });
  run("mel", "followups.update", { thread: ask, node: f1, q: "mine now", base: { rev: 1 } });
  run("mel", "followups.update", {
    thread: ask,
    node: f3,
    q: "Sideways again",
    run: true,
    pay: "KEY1",
    base: { rev: w.rev(`followup:${f3}`) },
  });
  run("mel", "threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "",
    from: { th: ask, node: f3 },
    branch: "all",
    title: "Promoted",
  });
  run("otto", "threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "",
    from: { th: ask, node: f1 },
    branch: "all",
  });
  run("mel", "threads.update", {
    id: ask,
    q: "Why, again?",
    base: { rev: w.rev(`thread:${ask}`) },
  });
  run("mel", "threads.update", { id: ask, q: "stale", base: { rev: 1 } });
  run("mel", "threads.update", {
    id: ask,
    q: "Why, again?",
    run: true,
    model: "m2",
    base: { rev: w.rev(`thread:${ask}`) },
  });
  run("otto", "threads.update", { id: ask, q: "not mine", base: { rev: w.rev(`thread:${ask}`) } });
  run("mona", "threads.move", { id: ask, topic: "t2" });
  run("mona", "threads.move", { id: ask, topic: "t9" });
  run("mel", "threads.move", { id: ask, topic: null });
  const r1 = w.id();
  run("mel", "research.createPostFollowUp", { id: r1, thread: post, t: "A reply" });
  const r2 = w.id();
  run("otto", "research.createPostFollowUp", { id: r2, thread: post, t: "Under it", parent: r1 });
  run("mel", "replies.update", { thread: post, reply: r1, t: "A reply, edited", base: { rev: 1 } });
  run("otto", "replies.update", { thread: post, reply: r1, t: "not mine", base: { rev: 2 } });
  run("otto", "likes.setReply", { reply: r1, on: true });
  run("otto", "likes.setReply", { reply: r1, on: true });
  run("eve", "likes.setReply", { reply: r2, on: false });
  run("otto", "replies.delete", { thread: post, reply: r2 });
  run("mel", "replies.delete", { thread: post, reply: r1 });
  run("otto", "likes.set", { thread: ask, on: true });
  run("eve", "likes.set", { thread: ask, on: true });
  run("eve", "likes.set", { thread: closedAsk, on: true });
  run("otto", "likes.set", { thread: ask, on: false });
  run("otto", "likes.set", { thread: post, on: true });
  run("otto", "saved.set", { kind: "thread", id: ask, on: true });
  run("otto", "saved.set", { kind: "ask", id: `${ask}:${f1}`, on: true });
  run("otto", "saved.set", { kind: "ask", id: `${ask}:r`, on: true });
  run("otto", "saved.set", { kind: "source", id: "SRC1", on: true });
  run("otto", "saved.set", { kind: "source", id: "NOPE", on: true });
  run("otto", "saved.set", { kind: "ask", id: `${ask}:r`, on: false });
  run("eve", "saved.set", { kind: "thread", id: closedAsk, on: true });
  run("otto", "followups.delete", { thread: ask, node: f1 });
  run("mel", "followups.delete", { thread: ask, node: f1 });
  run("mel", "followups.delete", { thread: ask, node: f2 });

  // personal
  run("otto", "mutes.set", { handle: "eve", on: true });
  run("otto", "mutes.set", { handle: "eve", on: false });
  run("otto", "blocks.set", { handle: "eve", on: true });
  run("otto", "sources.markRead", { id: "SRC1" });
  run("otto", "sources.markRead", { id: "NOPE" });
  run("otto", "profile.update", { name: " Otto ", bio: " hi " });
  run("otto", "profile.update", { name: " ", bio: "" });

  // join requests, members, bans and links
  run("eve", "joinRequests.create", { space: closed, rulesAccepted: true });
  run("eve", "joinRequests.create", { space: vault, rulesAccepted: true });
  run("mona", "joinRequests.decide", {
    space: closed,
    users: ["eve"],
    decision: "decline",
    why: "No.",
  });
  run("mona", "joinRequests.decide", {
    space: closed,
    users: ["eve"],
    decision: "reopen",
    base: w.requests(closed, ["eve"]),
  });
  run("eve", "joinRequests.withdraw", { space: closed });
  run("otto", "joinRequests.create", { space: closed, rulesAccepted: true });
  run("mona", "joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "approve",
    base: { otto: 0 },
  });
  admit(t, w, closed, "otto");
  run("mona", "members.setRole", { space: closed, user: "otto", role: "mod", base: { rev: 1 } });
  run("ada", "members.setRole", {
    space: closed,
    user: "otto",
    role: "mod",
    base: { rev: w.rev(`member:${closed}:otto`) },
  });
  run("mona", "members.remove", { space: closed, user: "otto", base: w.admission(closed, "otto") });
  run("ada", "members.remove", { space: closed, user: "otto", base: { adm: "old" } });
  run("ada", "members.remove", { space: closed, user: "otto", base: w.admission(closed, "otto") });
  run("mona", "members.ban", { space: open, user: "otto" });
  run("otto", "likes.set", { thread: post, on: false });
  run("otto", "threads.delete", { id: post });
  const lone = thread(t, w, "mel", closed, "post", "Alone");
  run("mel", "saved.set", { kind: "thread", id: lone, on: true });
  run("ada", "threads.delete", { id: lone });
  run("mel", "threads.delete", { id: lone });
  run("mona", "members.unban", { space: open, user: "otto" });
  run("mona", "members.unban", { space: open, user: "otto" });
  const link = w.id();
  run("mel", "invites.create", { id: link, space: closed, days: 7 });
  run("otto", "invites.create", { id: w.id(), space: open });
  run("mona", "invites.revoke", { id: link });
  run("mel", "invites.restore", { id: link });
  run("mel", "invites.restore", { id: link });
  const code = (w.get(`invite:${link}`) as { code: string }).code;
  run("eve", "spaces.join", { space: closed, invite: code });
  run("otto", "spaces.join", { space: closed, invite: code });
  run("eve", "spaces.leave", { space: closed });
  run("olga", "spaces.leave", { space: vault });
  run("eve", "invites.decline", { notification: w.id() });
  run("mona", "invites.decline", { notification: invite });
  run("eve", "spaces.join", { space: vault, notification: notice });
  run("eve", "spaces.join", { space: vault, notification: invite });
  run("eve", "invites.decline", { notification: invite });

  // reports and moderation
  const rep = w.id();
  run("otto", "reports.create", { id: rep, item: `a:${ask}`, why: "Off topic", note: " n " });
  run("mel", "reports.create", { id: w.id(), item: `a:${ask}`, why: "Spam" });
  run("eve", "reports.create", { id: w.id(), item: `a:${closedAsk}`, why: "x" });
  run("mona", "reports.resolve", { report: rep, outcome: "hidden" });
  run("mel", "threads.update", {
    id: ask,
    q: "Edited while hidden",
    base: { rev: w.rev(`thread:${ask}`) },
  });
  run("mona", "reports.resolve", { report: rep, outcome: "open" });
  run("mona", "reports.resolve", {
    report: rep,
    outcome: "open",
    base: { rev: w.rev(`report:${rep}`), item: 1 },
  });
  run("mona", "reports.resolve", {
    report: rep,
    outcome: "open",
    base: { rev: w.rev(`report:${rep}`), item: w.rev(`thread:${ask}`) },
  });
  run("mona", "reports.resolve", { report: rep, outcome: "dismissed" });
  run("mona", "moderation.decide", { item: `a:${ask}`, decision: "hidden" });
  run("mona", "moderation.decide", { item: `a:${ask}`, decision: "shown", base: { rev: 1 } });
  run("mona", "moderation.decide", {
    item: `a:${ask}`,
    decision: "shown",
    base: { rev: w.rev(`thread:${ask}`) },
  });
  run("mona", "moderation.decide", { item: `f:${ask}:${f3}`, decision: "removed" });
  run("mel", "notifications.markSeen", { kind: "reports" });
  run("mona", "notifications.markSeen", { kind: "reports" });
  run("mona", "notifications.markSeen", { kind: "requests" });
  run("mona", "notifications.markAllRead", {});
  run("mona", "notifications.markRead", { id: w.id() });
  run("mona", "notifications.markRead", { id: notice });
  run("eve", "notifications.markRead", { id: notice });

  // skills and pages, by id
  const [cite, short] = [w.id(), w.id()];
  run("mona", "skills.create", { id: cite, space: open, name: "Cite", prompt: "Cite sources." });
  run("mona", "skills.create", { id: w.id(), space: open, name: "Cite", prompt: "again" });
  run("mona", "skills.create", { id: short, space: open, name: "Short", prompt: "Be short." });
  run("mona", "skills.update", {
    space: open,
    id: cite,
    name: "Cite",
    prompt: "Cite.",
    base: { rev: 0 },
  });
  run("mona", "skills.update", {
    space: open,
    id: cite,
    name: "Cite",
    prompt: "x",
    base: { rev: 0 },
  });
  run("mona", "skills.reorder", { space: open, order: [short, cite], base: { rev: 1 } });
  run("mona", "skills.reorder", {
    space: open,
    order: [short, cite],
    base: { rev: w.rev(`skills:${open}`) },
  });
  run("mona", "skills.remove", { space: open, id: cite });
  run("mel", "skills.create", { id: w.id(), space: open, name: "No", prompt: "no" });
  const [guide, faq] = [w.id(), w.id()];
  run("mona", "pages.update", {
    space: open,
    page: null,
    id: guide,
    title: "Guide",
    text: ["One"],
  });
  run("mona", "pages.update", { space: open, id: faq, title: "FAQ", text: [] });
  run("mona", "pages.update", { space: open, id: w.id(), title: "faq", text: [] });
  run("mona", "pages.update", {
    space: open,
    page: guide,
    title: "Guide 2",
    text: ["Two"],
    base: { rev: 1 },
  });
  run("mona", "pages.update", {
    space: open,
    page: guide,
    title: "Guide 3",
    text: ["x"],
    base: { rev: 1 },
  });
  run("mel", "pages.update", { space: open, page: guide, title: "Guide", text: ["no"] });
  run("olga", "spaces.update", { id: open, set: { pageEdit: "members" } });
  run("mel", "pages.restore", { space: open, page: guide, rev: 1, note: "Back", base: { rev: 2 } });
  run("mona", "pages.move", { space: open, page: guide, other: faq });
  run("mona", "pages.remove", { space: open, page: faq });

  // sources
  run("mel", "spaceSources.add", {
    space: open,
    url: "https://www.example.org/a?x=1",
    note: "known",
  });
  run("mel", "spaceSources.add", { space: open, url: "https://arxiv.org/abs/2401.0001" });
  run("mel", "spaceSources.add", { space: open, file: "notes.pdf" });
  run("mona", "spaceSources.setPolicy", { space: closed, policy: "review" });
  run("mel", "spaceSources.add", { space: closed, source: "SRC1" });
  run("mel", "spaceSources.add", { space: closed, source: "SRC1" });
  run("mona", "spaceSources.review", { space: closed, source: "SRC1", decision: "approve" });
  run("mel", "sourceReports.create", { space: closed, source: "SRC1", why: "Broken" });
  run("mona", "spaceSources.review", { space: closed, source: "SRC1", decision: "keep" });
  run("mona", "spaceSources.review", { space: closed, source: "SRC1", decision: "remove" });
  run("mona", "spaceSources.review", { space: closed, source: "SRC1", decision: "restore" });
  run("mona", "spaceSources.review", { space: closed, source: "NOPE", decision: "approve" });

  // refusals
  run("mona", "spaces.delete", { id: closed });
  run("otto", "likes.setReply", { reply: w.id(), on: true });
  run("otto", "followups.ask", { id: w.id(), thread: post, q: "on a post" });
  run("otto", "research.createPostFollowUp", { id: w.id(), thread: ask, t: "on an ask" });
  run("otto", "replies.delete", { thread: post, reply: w.id() });
  run("eve", "joinRequests.withdraw", { space: w.id() });
  run("mel", "members.ban", { space: closed, user: "otto" });
  run("eve", "invites.revoke", { id: link });
  run("eve", "invites.request", { space: w.id() });
  run("eve", "reports.resolve", { report: rep, outcome: "dismissed" });
  run("mona", "skills.remove", { space: open, id: w.id() });
  run("mona", "skills.reorder", {
    space: open,
    order: [w.id()],
    base: { rev: w.rev(`skills:${open}`) },
  });
  run("mel", "pages.restore", { space: open, page: guide, rev: 99, note: "x" });
  run("mona", "pages.remove", { space: open, page: w.id() });
  run("mona", "pages.move", { space: open, page: guide, other: w.id() });
  run("mona", "members.remove", { space: open, user: "otto", base: { adm: "x" } });
  run("mel", "spaceSources.setPolicy", { space: open, policy: "mods" });
  run("eve", "sourceReports.create", { space: closed, source: "SRC1", why: "x" });

  // the end of a space
  w.advance(DAY);
  run("olga", "spaces.delete", { id: open });
  run("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "gone" });
  run("eve", "spaces.delete", { id: extra });
  run("olga", "spaces.leave", { space: closed });
  return w;
}
