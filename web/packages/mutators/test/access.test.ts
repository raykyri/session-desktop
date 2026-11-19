// The read rules, kind by kind, as a table written from the rules in
// AGENTS.md and replica-proto's read oracle: who may read each record, and
// what a hidden record's readers get. And the per-viewer fields and the
// time functions.

import test from "ava";

import {
  canRead,
  isoAt,
  msOf,
  redact,
  view,
  viewer,
  type Reader,
  type StoredRecord,
} from "../src/index.js";

import { cast, ok } from "./world.js";

const reader = (records: Map<string, StoredRecord>): Reader => ({
  get: (kind, id) => records.get(`${kind}:${id}`) as never,
});

/** Who reads what, in a world where the closed space #lab has owner olga,
 * admin ada, moderator mona and member mel, and the open #lounge has owner
 * olga, moderator mona and members mel and otto. eve is in neither; `null`
 * is signed out. Each row: a record's key (by a name below) and its readers. */
const PEOPLE = ["olga", "ada", "mona", "mel", "otto", "eve", null] as const;

test("each kind of record is read by exactly the people its rule names", (t) => {
  const { w, open, closed } = cast(t);
  const ids = {
    lab: w.id(),
    lounge: w.id(),
    fu: w.id(),
    reply: w.id(),
    post: w.id(),
    rep: w.id(),
    link: w.id(),
    ownLink: w.id(),
    page: w.id(),
  };
  ok(t, w.run("mel", "threads.create", { id: ids.lab, space: closed, kind: "ask", q: "Q" }));
  ok(t, w.run("mel", "followups.ask", { id: ids.fu, thread: ids.lab, q: "F" }));
  ok(t, w.run("mel", "threads.create", { id: ids.post, space: closed, kind: "post", q: "P" }));
  ok(t, w.run("mel", "research.createPostFollowUp", { id: ids.reply, thread: ids.post, t: "R" }));
  ok(t, w.run("otto", "threads.create", { id: ids.lounge, space: open, kind: "ask", q: "L" }));
  ok(t, w.run("mel", "likes.set", { thread: ids.lab, on: true }));
  ok(t, w.run("mel", "saved.set", { kind: "ask", id: `${ids.lab}:r`, on: true }));
  ok(t, w.run("mel", "likes.setReply", { reply: ids.reply, on: true }));
  ok(t, w.run("mel", "reports.create", { id: ids.rep, item: `a:${ids.lab}`, why: "W" }));
  ok(t, w.run("mona", "invites.create", { id: ids.link, space: closed }));
  ok(t, w.run("mel", "invites.create", { id: ids.ownLink, space: closed }));
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  ok(t, w.run("mona", "members.ban", { space: closed, user: "otto" }));
  ok(t, w.run("mel", "mutes.set", { handle: "eve", on: true }));
  ok(
    t,
    w.run("mona", "pages.update", { space: closed, id: ids.page, title: "Guide", text: ["x"] }),
  );
  ok(t, w.run("mona", "skills.create", { id: w.id(), space: closed, name: "S", prompt: "p" }));
  ok(t, w.run("eve", "invites.request", { space: closed }));
  w.key("mel", "K1");
  ok(t, w.run("mona", "spaceSources.setPolicy", { space: closed, policy: "review" }));
  ok(t, w.run("mel", "spaceSources.add", { space: closed, url: "example.org/pending" }));
  ok(t, w.run("mona", "spaceSources.add", { space: closed, url: "example.org/approved" }));
  ok(
    t,
    w.run("mel", "sourceReports.create", {
      space: closed,
      source: srcOf(w, closed, "mona"),
      why: "W",
    }),
  );
  const g = reader(w.store.records);
  const n = (to: string, type: string, sp: string) =>
    ({
      kind: "notif",
      id: "N",
      to,
      type,
      sp,
      report: null,
      item: null,
      outcome: null,
      response: null,
      actor: null,
      thread: null,
      node: null,
      read: false,
      createdAt: "",
      rev: 1,
    }) as StoredRecord;
  const staff = ["olga", "ada", "mona"];
  const labMembers = [...staff, "mel"];
  const all = [...PEOPLE];
  const rows: [string, StoredRecord, readonly (string | null)[]][] = [
    ["a closed space's record", w.get(`space:${closed}`) as StoredRecord, all],
    ["a closed space's stats", w.get(`stats:${closed}`) as StoredRecord, labMembers],
    ["an open space's stats", w.get(`stats:${open}`) as StoredRecord, all],
    ["a closed thread", w.get(`thread:${ids.lab}`) as StoredRecord, labMembers],
    ["its counts", w.get(`counts:${ids.lab}`) as StoredRecord, labMembers],
    ["its follow-up", w.get(`followup:${ids.fu}`) as StoredRecord, labMembers],
    ["a closed post's reply", w.get(`reply:${ids.reply}`) as StoredRecord, labMembers],
    ["an open thread", w.get(`thread:${ids.lounge}`) as StoredRecord, all],
    ["a member record of #lab", w.get(`member:${closed}:mel`) as StoredRecord, labMembers],
    ["a like in #lab", w.get(`like:mel:${ids.lab}`) as StoredRecord, ["mel"]],
    ["a saved ask in #lab", w.get(`asksave:mel:${ids.lab}:r`) as StoredRecord, ["mel"]],
    ["a reply like in #lab", w.get(`rlike:mel:${ids.reply}`) as StoredRecord, ["mel"]],
    ["a report", w.get(`report:${ids.rep}`) as StoredRecord, [...staff, "mel"]],
    ["a moderator's invite link", w.get(`invite:${ids.link}`) as StoredRecord, staff],
    ["a member's invite link", w.get(`invite:${ids.ownLink}`) as StoredRecord, labMembers],
    ["a join request", w.get(`request:${closed}:eve`) as StoredRecord, [...staff, "eve"]],
    ["a ban", w.get(`ban:${closed}:otto`) as StoredRecord, staff],
    ["a mute", w.get("mute:mel:eve") as StoredRecord, ["mel"]],
    ["a page list", w.get(`pages:${closed}`) as StoredRecord, labMembers],
    ["a page", w.get(`page:${ids.page}`) as StoredRecord, labMembers],
    ["skills", w.get(`skills:${closed}`) as StoredRecord, labMembers],
    // the record is the space's readers'; its fields are redacted (below)
    ["a source waiting for review", entry(w, closed, "mel"), labMembers],
    [
      "an invite ask (decision 8)",
      w.get(`invask:eve:${closed}`) as StoredRecord,
      [...staff, "eve"],
    ],
    ["an API key (decision 2)", w.get("apikey:K1") as StoredRecord, ["mel"]],
    ["an approved source", entry(w, closed, "mona"), labMembers],
    [
      "a source report",
      [...w.store.records.values()].find((r) => r.kind === "srcrep") as StoredRecord,
      [...staff, "mel"],
    ],
    ["a report notification", n("mona", "report", closed), ["mona"]],
    ["a report notification of a member", n("mel", "report", closed), []],
    ["a resolution notice", n("mel", "report_resolved", closed), ["mel"]],
    ["an invite to a closed space", n("eve", "invite", closed), ["eve"]],
  ];
  for (const [what, r, readers] of rows)
    for (const u of PEOPLE) t.is(canRead(g, r, u), readers.includes(u), `${what}, ${String(u)}`);
});

function entry(w: ReturnType<typeof cast>["w"], sp: string, by: string): StoredRecord {
  return [...w.store.records.values()].find(
    (r) => r.kind === "spacesrc" && r.sp === sp && r.by === by,
  ) as StoredRecord;
}
function srcOf(w: ReturnType<typeof cast>["w"], sp: string, by: string): string {
  return (entry(w, sp, by) as { src: string }).src;
}

test("hidden text is its author's and the moderators'; everyone else gets the placeholder", (t) => {
  const { w, open } = cast(t);
  const [th, fu, post, reply] = [w.id(), w.id(), w.id(), w.id()];
  ok(t, w.run("otto", "threads.create", { id: th, space: open, kind: "ask", q: "Q", title: "T" }));
  ok(t, w.run("otto", "followups.ask", { id: fu, thread: th, q: "F" }));
  ok(t, w.run("otto", "threads.create", { id: post, space: open, kind: "post", q: "P" }));
  ok(t, w.run("otto", "research.createPostFollowUp", { id: reply, thread: post, t: "R" }));
  for (const item of [`a:${th}`, `f:${th}:${fu}`, `r:${post}:${reply}`])
    ok(t, w.run("mona", "moderation.decide", { item, decision: "hidden" }));
  const g = reader(w.store.records);
  const thread = w.get(`thread:${th}`) as StoredRecord;
  for (const u of ["otto", "mona", "olga"]) t.deepEqual(redact(g, thread, u), thread, u);
  for (const u of ["mel", "eve", null])
    t.like(redact(g, thread, u), { q: "", t: null, sum: null }, String(u));
  t.like(view(g, w.get(`followup:${fu}`) as StoredRecord, "mel"), { q: "", a: null });
  t.like(view(g, w.get(`reply:${reply}`) as StoredRecord, null), { t: "" });
  t.like(view(g, w.get(`reply:${reply}`) as StoredRecord, "otto"), { t: "R" });
});

test("per-viewer fields are computed from the stored records", (t) => {
  const { w, open, closed } = cast(t);
  const th = w.id();
  ok(t, w.run("mel", "threads.create", { id: th, space: open, kind: "ask", q: "Q" }));
  ok(t, w.run("otto", "likes.set", { thread: th, on: true }));
  ok(t, w.run("otto", "saved.set", { kind: "thread", id: th, on: true }));
  ok(t, w.run("otto", "mutes.set", { handle: "mel", on: true }));
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  const g = reader(w.store.records);
  const p = w.get(`thread:${th}`) as Extract<StoredRecord, { kind: "thread" }>;
  t.like(viewer.threadView(g, p, "otto"), { likes: 1, liked: true, mine: false, r: 0 });
  t.like(viewer.threadView(g, p, "mel"), { likes: 1, liked: false, mine: true });
  t.true(viewer.saved(g, "otto", th));
  t.true(viewer.muted(g, "otto", "mel"));
  t.false(viewer.muted(g, null, "mel"));
  t.is(viewer.relation(g, closed, "eve"), "pending");
  t.is(viewer.relation(g, closed, "mona"), "mod");
  t.is(viewer.relation(g, closed, "mel"), "member");
  t.is(viewer.relation(g, closed, "otto"), "none");
  t.is(viewer.relation(g, open, "otto"), null);
  t.is(viewer.roleName(g, closed, "ada"), "Admin");
  t.is(viewer.roleName(g, closed, "eve"), null);
});

test("stored times convert without Date and agree with it", (t) => {
  for (const ms of [
    0,
    951_782_400_000,
    Date.UTC(2026, 10, 16, 10, 0, 0, 999),
    Date.UTC(2100, 1, 28, 23, 59, 59),
    -86_400_000,
  ]) {
    t.is(isoAt(ms), new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z"));
    t.is(msOf(isoAt(ms)), Math.floor(ms / 1000) * 1000);
  }
  t.is(msOf("2026-11-16T10:00Z"), Date.parse("2026-11-16T10:00Z"));
  t.is(msOf("2026-11-16T10:00:00.5Z"), Date.parse("2026-11-16T10:00:00.5Z"));
  t.true(Number.isNaN(msOf("yesterday")));
});
