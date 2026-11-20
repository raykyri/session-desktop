// Invariant 6: removed or hidden content is never served again to a reader
// who may not see it. Hidden text goes to its author and the space's owner
// only; removed text is erased from storage, with everything under it, and a
// removed thread's author is served to the author only. Log rows hold key, op and version only; a pull reads the record as it
// is now. Tombstones last 30 days, and an older cursor gets a snapshot.

import test from "ava";

import type {
  CommentRec,
  CountsRec,
  LogId,
  NodeRec,
  ReplyRec,
  TestServer,
  ThreadRec,
} from "../src/index.js";
import { TOMBSTONE_TTL } from "../src/index.js";

import { DAY, HOUR, MODEL, actor, admit, cast, forkInput, ok, refused, thread } from "./harness.js";
import { diff, expected } from "./oracle.js";

const SECRET = "the text that must not come back";
/** Every value the server keeps at rest: records, tombstones, log rows and
 * the idempotency store. There is no effect queue. */
const stored = async (w: { server: TestServer }) => JSON.stringify(await w.server.scanStorage());

test("after a hide, its author and the space's owner get the text; everyone else the placeholder", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  const readers = ["mel", "mona", "olga", "otto", "eve", null].map((u) => w.client(u));
  for (const c of readers) await c.sync(`space:${open}`);
  t.is((readers[0]?.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  for (const c of readers) {
    const u = c.actor?.u ?? null;
    const sees = u === "mel" || u === "olga";
    t.is(await c.sync(`space:${open}`), "pull");
    const p = c.records(`space:${open}`).get(`thread:${th}`) as ThreadRec;
    t.is(p.mod, "hidden");
    t.is(p.q, sees ? SECRET : "", String(u));
    const snap = await w.server.snapshot(c.actor, `space:${open}`);
    t.is(JSON.stringify(snap).includes(SECRET), sees, String(u));
    t.is(JSON.stringify([...c.records(`space:${open}`)]).includes(SECRET), sees, String(u));
  }
  // the owner may show a hidden item again (the mock's "shown"); its text is
  // served to everyone from then on
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th}`,
      decision: "shown",
      base: w.item(`p:${th}`),
    }),
  );
  await readers[3]?.sync(`space:${open}`);
  t.is((readers[3]?.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
});

test("removing a thread erases it and everything under it from storage, for good", async (t) => {
  // attack G of the phase 0 review: a removed thread's text stayed in storage,
  // and a follow-up quoting it was still served
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "mel", open, "ask", SECRET);
  const fu = w.id();
  await ok(t, w.as("otto", "research.forkNode", forkInput(fu, th, `you said ${SECRET}?`)));
  t.true(await w.server.finishJob(`node:${fu}`, `the answer: ${SECRET}`));
  await ok(
    t,
    w.as("mona", "comments.create", { id: w.id(), thread: th, node: fu, t: `@mel ${SECRET}` }),
  );
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: true }));
  const post = await thread(t, w, "mel", closed, "post", SECRET);
  const top = w.id();
  const nested = w.id();
  await ok(
    t,
    w.as("ada", "research.createPostFollowUp", { id: top, thread: post, t: `@mona ${SECRET}` }),
  );
  await ok(
    t,
    w.as("mona", "research.createPostFollowUp", {
      id: nested,
      thread: post,
      t: SECRET,
      parent: top,
    }),
  );
  await ok(t, w.as("ada", "saved.set", { kind: "thread", id: post, on: true }));
  t.is(w.notifs("mona").filter((n) => n.type === "mention").length, 1);
  t.is(w.notifs("mel").filter((n) => n.type === "mention").length, 1);
  const readers = ["mel", "mona", "olga", "ada", "otto", "eve", null].map((u) => w.client(u));
  for (const c of readers)
    for (const log of [
      `space:${open}`,
      `space:${closed}`,
      ...(c.actor ? [`user:${c.actor.u}`] : []),
    ] as LogId[])
      await c.sync(log);
  await ok(
    t,
    w.as("olga", "moderation.decide", { item: `a:${th}`, decision: "removed", note: "Off topic." }),
  );
  await ok(t, w.as("olga", "moderation.decide", { item: `p:${post}`, decision: "removed" }));
  // erased at rest: the text, the nodes, answers, comments, runs, replies and
  // saves, and the mention notifications about them
  t.false((await stored(w)).includes(SECRET));
  for (const key of [`node:${fu}`, `answer:${fu}`, `reply:${top}`, `reply:${nested}`])
    t.false(w.server.dump().has(key));
  for (const kind of ["run", "comment", "save"])
    t.false(
      [...w.server.dump().values()].some((r) => r.kind === kind && (r as { th: string }).th === th),
      kind,
    );
  t.is(w.notifs("mona").filter((n) => n.type === "mention").length, 0);
  t.is(w.notifs("mel").filter((n) => n.type === "mention").length, 0);
  const p = w.get(`thread:${post}`) as ThreadRec;
  const pCounts = w.get(`counts:${post}`) as CountsRec;
  t.is(p.mod, "removed");
  t.is(pCounts.r, 0);
  t.is(pCounts.saves, 0);
  t.false(w.server.dump().has(`save:ada:${post}`));
  // the placeholder keeps who removed it and why; the author is notified,
  // with the reason and no text
  const removedAsk = w.get(`thread:${th}`) as ThreadRec;
  t.like(removedAsk, { mod: "removed", modBy: "olga", modNote: "Off topic.", u: "mel", q: "" });
  t.like(p, { modBy: "olga", modNote: null });
  const told = w.notifs("mel").filter((n) => n.type === "removed");
  t.deepEqual(
    told.map((n) => [n.th, n.note, n.actor]),
    [
      [th, "Off topic.", null],
      [post, null, null],
    ],
  );
  // every reader's replica loses it through a pull, with `del`s for the children
  for (const c of readers)
    for (const log of [`space:${open}`, `space:${closed}`] as LogId[]) {
      t.is(await c.sync(log), "pull");
      t.false(JSON.stringify([...c.records(log)]).includes(SECRET));
      t.is(diff(c.records(log), expected(w.server.dump(), c.actor?.u ?? null, log)), null);
    }
  // the placeholder names its author to the author only, the owner included
  for (const c of readers) {
    const got = c.records(`space:${open}`).get(`thread:${th}`) as ThreadRec;
    t.is(got.u, c.actor?.u === "mel" ? "mel" : null, String(c.actor?.u));
  }
  // nothing brings it back, and nothing new goes under it
  // from the removed state, and from the state before it
  const now = w.item(`a:${th}`);
  for (const decision of ["shown", "hidden", "removed"] as const) {
    const input = { item: `a:${th}`, decision };
    await refused(
      t,
      w.as("olga", "moderation.decide", { ...input, base: now }),
      "PRECONDITION_FAILED",
    );
    // only "shown" compares the rev; the restricting decisions find the
    // item removed (review round 2, finding 2)
    await refused(
      t,
      w.as("olga", "moderation.decide", { ...input, base: { rev: now.rev - 1 } }),
      decision === "shown" ? "STALE" : "PRECONDITION_FAILED",
    );
  }
  await refused(
    t,
    w.as("mel", "threads.update", {
      id: th,
      q: SECRET,
      base: { rev: w.get(`thread:${th}`)?.rev ?? 0 },
    }),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("otto", "saved.set", { kind: "thread", id: th, on: true }),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("otto", "research.forkNode", forkInput(w.id(), th, "more")),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("otto", "comments.create", { id: w.id(), thread: th, node: "r", t: "more" }),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: post, t: "more" }),
    "PRECONDITION_FAILED",
  );
  // taking a save back still works, and writes nothing: the removal took it
  await ok(t, w.as("ada", "saved.set", { kind: "thread", id: post, on: false }));
  t.false((await stored(w)).includes(SECRET));
});

test("removing a node, a top-level reply or a top-level comment erases its text, and what is under it", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const post = await thread(t, w, "mel", open, "post");
  const fu = w.id();
  const rp = w.id();
  const under = w.id();
  const cm = w.id();
  const cmUnder = w.id();
  const onNode = w.id();
  await ok(t, w.as("otto", "research.forkNode", { ...forkInput(fu, ask, SECRET), quote: SECRET }));
  t.true(await w.server.finishJob(`node:${fu}`, SECRET));
  await ok(t, w.as("mona", "comments.create", { id: onNode, thread: ask, node: fu, t: SECRET }));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: SECRET }));
  await ok(
    t,
    w.as("mel", "research.createPostFollowUp", { id: under, thread: post, t: SECRET, parent: rp }),
  );
  await ok(t, w.as("otto", "comments.create", { id: cm, thread: ask, node: "r", t: SECRET }));
  await ok(
    t,
    w.as("mel", "comments.create", { id: cmUnder, thread: ask, node: "r", t: SECRET, parent: cm }),
  );
  t.is((w.get(`counts:${post}`) as CountsRec).r, 2);
  for (const item of [`f:${ask}:${fu}`, `r:${post}:${rp}`, `c:${ask}:${cm}`])
    await ok(t, w.as("olga", "moderation.decide", { item, decision: "removed" }));
  t.false((await stored(w)).includes(SECRET));
  t.is((w.get(`node:${fu}`) as NodeRec).mod, "removed");
  t.is((w.get(`reply:${rp}`) as ReplyRec).mod, "removed");
  t.is((w.get(`comment:${cm}`) as CommentRec).mod, "removed");
  for (const key of [`answer:${fu}`, `comment:${onNode}`, `reply:${under}`, `comment:${cmUnder}`])
    t.false(w.server.dump().has(key), key);
  // the removed reply stays as a placeholder; the one under it is gone
  t.is((w.get(`counts:${post}`) as CountsRec).r, 1);
  // three removals, three entries in the moderation log, and no `removed`
  // notification: only a thread's removal notifies
  const log = [...w.server.dump().values()].filter((r) => r.kind === "modlog");
  t.deepEqual(
    log.map((r) => (r.kind === "modlog" ? [r.act, r.author] : null)),
    [
      ["remove", "otto"],
      ["remove", "otto"],
      ["remove", "otto"],
    ],
  );
  t.false(w.notifs("otto").some((n) => n.type === "removed"));
  await refused(
    t,
    w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: post, t: "x", parent: rp }),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("mel", "research.forkNode", forkInput(w.id(), ask, "x", fu)),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("mel", "comments.create", { id: w.id(), thread: ask, node: "r", t: "x", parent: cm }),
    "PRECONDITION_FAILED",
  );
  // the thread itself takes replies, nodes and comments as before
  await ok(t, w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: post, t: "x" }));
  await ok(t, w.as("mel", "research.forkNode", forkInput(w.id(), ask, "x")));
  await ok(t, w.as("mel", "comments.create", { id: w.id(), thread: ask, node: "r", t: "x" }));
});

test("hidden nodes, answers, replies and comments lose their text for readers who are not their author or the owner", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const post = await thread(t, w, "mel", open, "post");
  const fu = w.id();
  const rp = w.id();
  const cm = w.id();
  await ok(t, w.as("otto", "research.forkNode", { ...forkInput(fu, ask, SECRET), quote: SECRET }));
  t.true(await w.server.finishJob(`node:${fu}`, SECRET));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: SECRET }));
  await ok(t, w.as("otto", "comments.create", { id: cm, thread: ask, node: fu, t: SECRET }));
  const c = w.client(null);
  await c.sync(`space:${open}`);
  for (const item of [`f:${ask}:${fu}`, `r:${post}:${rp}`, `c:${ask}:${cm}`])
    await ok(
      t,
      w.as("olga", "moderation.decide", { item, decision: "hidden", base: w.item(item) }),
    );
  await c.sync(`space:${open}`);
  const got = c.records(`space:${open}`);
  t.like(got.get(`node:${fu}`), { q: "", quote: null, mod: "hidden" });
  t.like(got.get(`answer:${fu}`), { md: "", mod: "hidden" });
  t.is((got.get(`reply:${rp}`) as ReplyRec).t, "");
  t.is((got.get(`comment:${cm}`) as CommentRec).t, "");
  for (const u of ["eve", "mel", "mona", null])
    t.false(
      JSON.stringify(await w.server.snapshot(actor(u), `space:${open}`)).includes(SECRET),
      String(u),
    );
  for (const u of ["otto", "olga"])
    t.true(JSON.stringify(await w.server.snapshot(actor(u), `space:${open}`)).includes(SECRET), u);
  // shown again: the answer comes back with its node
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `f:${ask}:${fu}`,
      decision: "shown",
      base: w.item(`f:${ask}:${fu}`),
    }),
  );
  await c.sync(`space:${open}`);
  t.like(c.records(`space:${open}`).get(`answer:${fu}`), { md: SECRET, mod: null });
  // a key that names the item under another thread is NOT_FOUND
  await refused(
    t,
    w.as("olga", "moderation.decide", {
      item: `f:${post}:${fu}`,
      decision: "hidden",
      base: w.item(`f:${post}:${fu}`),
    }),
    "NOT_FOUND",
  );
});

test("an author's delete takes the text out of what is served", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: true }));
  const otto = w.client("otto");
  await otto.sync(`space:${open}`);
  await otto.sync("user:otto");
  t.true(otto.records("user:otto").has(`save:otto:${th}`));
  await ok(t, w.as("mel", "threads.delete", { id: th }));
  await otto.sync(`space:${open}`);
  await otto.sync("user:otto");
  const p = otto.records(`space:${open}`).get(`thread:${th}`) as ThreadRec;
  t.true(p.gone);
  t.is(p.q, "");
  t.false(otto.records("user:otto").has(`save:otto:${th}`));
  t.is((otto.records(`space:${open}`).get(`counts:${th}`) as CountsRec).saves, 0);
  t.false((await stored(w)).includes(SECRET));
});

test("an old cursor resyncs into the current state, never the content it last saw", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  const eve = w.client("eve");
  await eve.sync(`space:${open}`);
  await ok(t, w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "removed" }));
  // the log's history is replaced (a restore), so eve's cursor is from another epoch
  await w.server.replaceHistory(`space:${open}`);
  t.is(await eve.sync(`space:${open}`), "resync");
  t.is((eve.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, "");
  t.is(diff(eve.records(`space:${open}`), expected(w.server.dump(), "eve", `space:${open}`)), null);
});

test("a delete reaches a pull as a tombstone for 30 days; after that the cursor resyncs", async (t) => {
  const { w, closed } = await cast(t);
  const log: LogId = `space:${closed}`;
  const mel = w.client("mel");
  const late = w.client("ada");
  await mel.sync(log);
  await late.sync(log);
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mona",
      base: w.admission(closed, "mona"),
    }),
  );
  t.false(w.server.dump().has(`member:${closed}:mona`));
  w.clock.advance(29 * DAY);
  t.is(await mel.sync(log), "pull");
  t.false(mel.records(log).has(`member:${closed}:mona`));
  t.true(
    (await w.server.logRows(log)).some((r) => r.key === `member:${closed}:mona` && r.op === "del"),
  );
  w.clock.advance(DAY + HOUR);
  // the tombstone is gone, and so is the row: ada's cursor is older than it
  t.false((await w.server.logRows(log)).some((r) => r.key === `member:${closed}:mona`));
  t.is(await late.sync(log), "resync");
  t.false(late.records(log).has(`member:${closed}:mona`));
  t.is(diff(late.records(log), expected(w.server.dump(), "ada", log)), null);
});

test("a delete committed in the same millisecond as a cursor is served at the 30-day boundary", async (t) => {
  // attack D of the phase 0 review: at exactly 30 days, the cursor was still
  // accepted but the tombstone of a delete from its own millisecond was gone
  const { w, closed } = await cast(t);
  const log: LogId = `space:${closed}`;
  await admit(t, w, closed, "otto");
  w.clock.advance(HOUR);
  const mona = w.client("mona");
  const kept = w.client("ada");
  await thread(t, w, "mel", closed, "post");
  await mona.sync(log);
  await kept.sync(log);
  // same millisecond as the cursor's version
  await ok(t, w.as("otto", "spaces.leave", { space: closed }));
  w.clock.advance(TOMBSTONE_TTL);
  t.is(await mona.sync(log), "pull");
  t.false(mona.records(log).has(`member:${closed}:otto`));
  t.is(diff(mona.records(log), expected(w.server.dump(), "mona", log)), null);
  // one millisecond later the cursor is too old, and resyncs
  w.clock.advance(1);
  t.is(await kept.sync(log), "resync");
  t.false(kept.records(log).has(`member:${closed}:otto`));
});

test("a cursor older than 30 days resyncs even when nothing was deleted", async (t) => {
  const { w, open } = await cast(t);
  const c = w.client("otto");
  await c.sync(`space:${open}`);
  w.clock.advance(30 * DAY + 1);
  t.is(await c.sync(`space:${open}`), "resync");
});

test("log rows hold key, op and version only, and a pull reads the record as it is now", async (t) => {
  const { w, open, closed } = await cast(t);
  const c = w.client("mel");
  await c.sync(`space:${open}`);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  await ok(t, w.as("mel", "threads.update", { id: th, q: "second", base: { rev: 1 } }));
  await ok(t, w.as("mel", "threads.update", { id: th, q: "third", base: { rev: 2 } }));
  for (const log of [`space:${open}`, `space:${closed}`, "user:mel"] as LogId[])
    for (const row of await w.server.logRows(log)) {
      t.deepEqual(Object.keys(row).sort(), ["key", "op", "version"]);
      t.false(JSON.stringify(row).includes(SECRET));
    }
  const p = await w.server.pull(actor("mel"), `space:${open}`, c.cursor(`space:${open}`)!);
  if ("resync" in p) return t.fail("unexpected resync");
  const mine = p.changes.filter((x) => x.key === `thread:${th}`);
  t.is(mine.length, 1);
  t.is(mine[0]?.op === "put" ? (mine[0].record as ThreadRec).q : null, "third");
  t.false(JSON.stringify(p).includes(SECRET));
});

test("snapshots and pulls hand out copies: changing one changes nothing on the server", async (t) => {
  const { w, open } = await cast(t);
  const c = w.client("mel");
  await c.sync(`space:${open}`);
  const th = await thread(t, w, "mel", open, "post", "kept");
  const s = await w.server.snapshot(actor("mel"), `space:${open}`);
  for (const x of s.records) Object.assign(x.record, { rev: 999, q: SECRET, saves: 999 });
  const p = await w.server.pull(actor("mel"), `space:${open}`, c.cursor(`space:${open}`)!);
  if ("resync" in p) return t.fail("unexpected resync");
  for (const x of p.changes) if (x.op === "put") Object.assign(x.record, { q: SECRET });
  t.false((await stored(w)).includes(SECRET));
  t.is((w.get(`counts:${th}`) as CountsRec).saves, 0);
});

test("hiding and removing redact every text field: question, title, summary, node question, quote, phrase and answer, reply, comment", async (t) => {
  const { w, open } = await cast(t);
  const ask = w.id();
  const post = w.id();
  const fu = w.id();
  const lk = w.id();
  const rp = w.id();
  const cm = w.id();
  await ok(
    t,
    w.as("mel", "threads.create", {
      id: ask,
      space: open,
      kind: "ask",
      q: "MK-ASK-Q",
      title: "MK-ASK-T",
      ...MODEL,
    }),
  );
  await ok(
    t,
    w.as("mel", "threads.create", {
      id: post,
      space: open,
      kind: "post",
      q: "MK-POST-Q",
      title: "MK-POST-T",
    }),
  );
  t.true(await w.server.finishJob(`thread:${ask}`, "MK-ASK-SUM"));
  t.true(await w.server.finishJob(`thread:${post}`, "MK-POST-SUM"));
  await ok(
    t,
    w.as("otto", "research.forkNode", { ...forkInput(fu, ask, "MK-FU-Q"), quote: "MK-FU-QT" }),
  );
  t.true(await w.server.finishJob(`node:${fu}`, "MK-FU-A"));
  await ok(
    t,
    w.as("otto", "research.forkNode", {
      id: lk,
      thread: ask,
      parent: fu,
      kind: "lookup",
      look: "MK-LK-P",
      ...MODEL,
    }),
  );
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: "MK-RP-T" }));
  await ok(t, w.as("otto", "comments.create", { id: cm, thread: ask, node: fu, t: "MK-CM-T" }));
  const markers = (s: unknown) => (JSON.stringify(s).match(/MK-[A-Z]+-[A-Z]+/g) ?? []).sort();
  // a look-up's phrase is stored as `look` and inside its prompt `q`
  const all = [
    "MK-ASK-Q",
    "MK-ASK-SUM",
    "MK-ASK-T",
    "MK-CM-T",
    "MK-FU-A",
    "MK-FU-Q",
    "MK-FU-QT",
    "MK-LK-P",
    "MK-LK-P",
    "MK-POST-Q",
    "MK-POST-SUM",
    "MK-POST-T",
    "MK-RP-T",
  ];
  const seen = async (u: string | null) =>
    markers((await w.server.snapshot(actor(u), `space:${open}`)).records);
  t.deepEqual(await seen(null), all);
  const decide = (item: string, decision: string) =>
    ok(t, w.as("olga", "moderation.decide", { item, decision, base: w.item(item) }));
  const items = [
    `a:${ask}`,
    `p:${post}`,
    `f:${ask}:${fu}`,
    `f:${ask}:${lk}`,
    `r:${post}:${rp}`,
    `c:${ask}:${cm}`,
  ];
  for (const item of items) await decide(item, "hidden");
  // hidden: the author of each item and the space's owner get its text, nobody else
  for (const u of [null, "eve", "ada", "mona"]) t.deepEqual(await seen(u), [], String(u));
  t.deepEqual(await seen("olga"), all);
  t.deepEqual(await seen("mel"), [
    "MK-ASK-Q",
    "MK-ASK-SUM",
    "MK-ASK-T",
    "MK-POST-Q",
    "MK-POST-SUM",
    "MK-POST-T",
  ]);
  t.deepEqual(await seen("otto"), [
    "MK-CM-T",
    "MK-FU-A",
    "MK-FU-Q",
    "MK-FU-QT",
    "MK-LK-P",
    "MK-LK-P",
    "MK-RP-T",
  ]);
  // removed: no reader gets any of it, and no value at rest holds it
  // the comment first: removing its node takes the comment with it
  for (const item of [...items.slice(2).reverse(), `a:${ask}`, `p:${post}`])
    await decide(item, "removed");
  for (const u of [null, "eve", "mel", "otto", "mona", "olga"])
    t.deepEqual(await seen(u), [], String(u));
  t.deepEqual(markers(await w.server.scanStorage()), []);
});
