// Invariant 6: removed or hidden content is never served again to a reader
// who may not see it. Hidden text goes to its author and the space's
// moderators only; removed text is erased from storage, with everything under
// it. Log rows hold key, op and version only; a pull reads the record as it
// is now. Tombstones last 30 days, and an older cursor gets a snapshot.

import test from "ava";

import type {
  FollowUpRec,
  LogId,
  ReplyRec,
  TestServer,
  CountsRec,
  ThreadRec,
} from "../src/index.js";
import { TOMBSTONE_TTL } from "../src/index.js";

import { DAY, HOUR, actor, admit, cast, ok, refused, thread } from "./harness.js";
import { diff, expected } from "./oracle.js";

const SECRET = "the text that must not come back";
/** Every value the server keeps at rest: records, tombstones, log rows, the
 * idempotency store and the effect queue. */
const stored = async (w: { server: TestServer }) => JSON.stringify(await w.server.scanStorage());

test("after a hide, its author and the space's moderators get the text; everyone else the placeholder", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  const readers = ["mel", "mona", "olga", "otto", "eve", null].map((u) => w.client(u));
  for (const c of readers) await c.sync(`space:${open}`);
  t.is((readers[0]?.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  for (const c of readers) {
    const u = c.actor?.u ?? null;
    const sees = u === "mel" || u === "mona" || u === "olga";
    t.is(await c.sync(`space:${open}`), "pull");
    const p = c.records(`space:${open}`).get(`thread:${th}`) as ThreadRec;
    t.is(p.mod, "hidden");
    t.is(p.q, sees ? SECRET : "", String(u));
    const snap = await w.server.snapshot(c.actor, `space:${open}`);
    t.is(JSON.stringify(snap).includes(SECRET), sees, String(u));
    t.is(JSON.stringify([...c.records(`space:${open}`)]).includes(SECRET), sees, String(u));
  }
  // a moderator may show a hidden item again (the mock's "shown"); its text is
  // served to everyone from then on
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "shown",
      base: w.item(`p:${th}`),
    }),
  );
  await readers[3]?.sync(`space:${open}`);
  t.is((readers[3]?.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
});

test("a demoted moderator stops getting hidden text, and a promoted member starts", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "ada", closed, "post", SECRET);
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  const mona = w.client("mona");
  const mel = w.client("mel");
  await mona.sync(`space:${closed}`);
  await mel.sync(`space:${closed}`);
  t.is((mona.records(`space:${closed}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
  t.is((mel.records(`space:${closed}`).get(`thread:${th}`) as ThreadRec).q, "");
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mona",
      role: "member",
      base: w.member(closed, "mona"),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mel",
      role: "mod",
      base: w.member(closed, "mel"),
    }),
  );
  t.is(await mona.sync(`space:${closed}`), "resync");
  t.is(await mel.sync(`space:${closed}`), "resync");
  t.is((mona.records(`space:${closed}`).get(`thread:${th}`) as ThreadRec).q, "");
  t.is((mel.records(`space:${closed}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
});

test("removing a thread erases it and everything under it from storage, for good", async (t) => {
  // attack G of the phase 0 review: a removed thread's text stayed in storage,
  // and a follow-up quoting it was still served
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "mel", open, "ask", SECRET);
  const fu = w.id();
  await ok(t, w.as("otto", "followups.ask", { id: fu, thread: th, q: `you said ${SECRET}?` }));
  const post = await thread(t, w, "mel", closed, "post", SECRET);
  const top = w.id();
  const nested = w.id();
  await ok(t, w.as("ada", "research.createPostFollowUp", { id: top, thread: post, t: SECRET }));
  await ok(
    t,
    w.as("mona", "research.createPostFollowUp", {
      id: nested,
      thread: post,
      t: SECRET,
      parent: top,
    }),
  );
  await ok(t, w.as("ada", "likes.set", { thread: post, on: true }));
  const readers = ["mel", "mona", "olga", "ada", "otto", "eve", null].map((u) => w.client(u));
  for (const c of readers)
    for (const log of [`space:${open}`, `space:${closed}`] as LogId[]) await c.sync(log);
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `a:${th}`,
      decision: "removed",
      base: w.item(`a:${th}`),
    }),
  );
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${post}`,
      decision: "removed",
      base: w.item(`p:${post}`),
    }),
  );
  // erased at rest: the text, the follow-ups, the runs and the replies
  t.false((await stored(w)).includes(SECRET));
  for (const key of [`followup:${fu}`, `reply:${top}`, `reply:${nested}`])
    t.false(w.server.dump().has(key));
  t.false([...w.server.dump().values()].some((r) => r.kind === "run" && r.th === th));
  const p = w.get(`thread:${post}`) as ThreadRec;
  const pCounts = w.get(`counts:${post}`) as CountsRec;
  t.is(p.mod, "removed");
  t.is(pCounts.r, 0);
  t.is(pCounts.likes, 1);
  // every reader's replica loses it through a pull, with `del`s for the children
  for (const c of readers)
    for (const log of [`space:${open}`, `space:${closed}`] as LogId[]) {
      t.is(await c.sync(log), "pull");
      t.false(JSON.stringify([...c.records(log)]).includes(SECRET));
      t.is(diff(c.records(log), expected(w.server.dump(), c.actor?.u ?? null, log)), null);
    }
  // nothing brings it back, and nothing new goes under it
  // from the removed state, and from the state before it
  const now = w.item(`a:${th}`);
  for (const decision of ["shown", "hidden", "removed"] as const) {
    const input = { item: `a:${th}`, decision };
    await refused(
      t,
      w.as("mona", "moderation.decide", { ...input, base: now }),
      "PRECONDITION_FAILED",
    );
    // only "shown" compares the rev; the restricting decisions find the
    // item removed (review round 2, finding 2)
    await refused(
      t,
      w.as("mona", "moderation.decide", { ...input, base: { rev: now.rev - 1 } }),
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
  await refused(t, w.as("otto", "likes.set", { thread: th, on: true }), "PRECONDITION_FAILED");
  await refused(
    t,
    w.as("otto", "followups.ask", { id: w.id(), thread: th, q: "more" }),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: post, t: "more" }),
    "PRECONDITION_FAILED",
  );
  // taking a like back still works
  await ok(t, w.as("ada", "likes.set", { thread: post, on: false }));
  t.false((await stored(w)).includes(SECRET));
});

test("removing a follow-up or a top-level reply erases its text, and the replies under the reply", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const post = await thread(t, w, "mel", open, "post");
  const fu = w.id();
  const rp = w.id();
  const under = w.id();
  await ok(t, w.as("otto", "followups.ask", { id: fu, thread: ask, q: SECRET }));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: SECRET }));
  await ok(
    t,
    w.as("mel", "research.createPostFollowUp", { id: under, thread: post, t: SECRET, parent: rp }),
  );
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `f:${ask}:${fu}`,
      decision: "removed",
      base: w.item(`f:${ask}:${fu}`),
    }),
  );
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `r:${post}:${rp}`,
      decision: "removed",
      base: w.item(`r:${post}:${rp}`),
    }),
  );
  t.false((await stored(w)).includes(SECRET));
  t.is((w.get(`followup:${fu}`) as FollowUpRec).mod, "removed");
  t.is((w.get(`reply:${rp}`) as ReplyRec).mod, "removed");
  t.false(w.server.dump().has(`reply:${under}`));
  await refused(
    t,
    w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: post, t: "x", parent: rp }),
    "PRECONDITION_FAILED",
  );
  // the thread itself takes replies as before
  await ok(t, w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: post, t: "x" }));
});

test("hidden follow-ups and replies lose their text for readers who are not their author or staff", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const post = await thread(t, w, "mel", open, "post");
  const fu = w.id();
  const rp = w.id();
  await ok(t, w.as("otto", "followups.ask", { id: fu, thread: ask, q: SECRET }));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: SECRET }));
  const c = w.client(null);
  await c.sync(`space:${open}`);
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `f:${ask}:${fu}`,
      decision: "hidden",
      base: w.item(`f:${ask}:${fu}`),
    }),
  );
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `r:${post}:${rp}`,
      decision: "hidden",
      base: w.item(`r:${post}:${rp}`),
    }),
  );
  await c.sync(`space:${open}`);
  t.is((c.records(`space:${open}`).get(`followup:${fu}`) as FollowUpRec).q, "");
  t.is((c.records(`space:${open}`).get(`reply:${rp}`) as ReplyRec).t, "");
  for (const u of ["eve", "mel", null])
    t.false(
      JSON.stringify(await w.server.snapshot(actor(u), `space:${open}`)).includes(SECRET),
      String(u),
    );
  for (const u of ["otto", "mona", "olga"])
    t.true(JSON.stringify(await w.server.snapshot(actor(u), `space:${open}`)).includes(SECRET), u);
  // a key that names the item under another thread is NOT_FOUND
  await refused(
    t,
    w.as("mona", "moderation.decide", {
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
  await ok(t, w.as("otto", "likes.set", { thread: th, on: true }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: true }));
  const otto = w.client("otto");
  await otto.sync(`space:${open}`);
  await otto.sync("user:otto");
  t.true(otto.records("user:otto").has(`like:otto:${th}`));
  await ok(t, w.as("mel", "threads.delete", { id: th }));
  await otto.sync(`space:${open}`);
  await otto.sync("user:otto");
  const p = otto.records(`space:${open}`).get(`thread:${th}`) as ThreadRec;
  t.true(p.gone);
  t.is(p.q, "");
  t.false(otto.records("user:otto").has(`like:otto:${th}`));
  t.false(otto.records("user:otto").has(`save:otto:${th}`));
  t.false((await stored(w)).includes(SECRET));
});

test("an old cursor resyncs into the current state, never the content it last saw", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  const eve = w.client("eve");
  await eve.sync(`space:${open}`);
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "removed",
      base: w.item(`p:${th}`),
    }),
  );
  // the log's history is replaced (a visibility change), so eve's cursor is from another epoch
  await ok(t, w.as("olga", "spaces.update", { id: open, set: { vis: "listed" } }));
  await ok(t, w.as("olga", "spaces.update", { id: open, set: { vis: "open" } }));
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
  for (const x of s.records) Object.assign(x.record, { rev: 999, q: SECRET, likes: 999 });
  const p = await w.server.pull(actor("mel"), `space:${open}`, c.cursor(`space:${open}`)!);
  if ("resync" in p) return t.fail("unexpected resync");
  for (const x of p.changes) if (x.op === "put") Object.assign(x.record, { q: SECRET });
  t.false((await stored(w)).includes(SECRET));
  t.is((w.get(`counts:${th}`) as CountsRec).likes, 0);
});

test("hiding and removing redact every text field: question, title, summary, follow-up question and answer, reply", async (t) => {
  const { w, open } = await cast(t);
  const ask = w.id();
  const post = w.id();
  const fu = w.id();
  const rp = w.id();
  await ok(
    t,
    w.as("mel", "threads.create", {
      id: ask,
      space: open,
      kind: "ask",
      q: "MK-ASK-Q",
      title: "MK-ASK-T",
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
  await ok(t, w.as("otto", "followups.ask", { id: fu, thread: ask, q: "MK-FU-Q" }));
  t.true(await w.server.finishJob(`followup:${fu}`, "MK-FU-A"));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: "MK-RP-T" }));
  const markers = (s: unknown) => (JSON.stringify(s).match(/MK-[A-Z]+-[A-Z]+/g) ?? []).sort();
  const all = [
    "MK-ASK-Q",
    "MK-ASK-SUM",
    "MK-ASK-T",
    "MK-FU-A",
    "MK-FU-Q",
    "MK-POST-Q",
    "MK-POST-SUM",
    "MK-POST-T",
    "MK-RP-T",
  ];
  const seen = async (u: string | null) =>
    markers((await w.server.snapshot(actor(u), `space:${open}`)).records);
  t.deepEqual(await seen(null), all);
  const decide = (item: string, decision: string) =>
    ok(t, w.as("mona", "moderation.decide", { item, decision, base: w.item(item) }));
  for (const item of [`a:${ask}`, `p:${post}`, `f:${ask}:${fu}`, `r:${post}:${rp}`])
    await decide(item, "hidden");
  // hidden: the author of each item and the space's staff get its text, nobody else
  for (const u of [null, "eve", "ada"]) t.deepEqual(await seen(u), [], String(u));
  for (const u of ["mona", "olga"]) t.deepEqual(await seen(u), all, u);
  t.deepEqual(await seen("mel"), [
    "MK-ASK-Q",
    "MK-ASK-SUM",
    "MK-ASK-T",
    "MK-POST-Q",
    "MK-POST-SUM",
    "MK-POST-T",
  ]);
  t.deepEqual(await seen("otto"), ["MK-FU-A", "MK-FU-Q", "MK-RP-T"]);
  // removed: no reader gets any of it, and no value at rest holds it
  for (const item of [`f:${ask}:${fu}`, `r:${post}:${rp}`, `a:${ask}`, `p:${post}`])
    await decide(item, "removed");
  for (const u of [null, "eve", "mel", "otto", "mona", "olga"])
    t.deepEqual(await seen(u), [], String(u));
  t.deepEqual(markers(await w.server.scanStorage()), []);
});
