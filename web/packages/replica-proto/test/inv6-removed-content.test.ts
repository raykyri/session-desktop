// Invariant 6: removed or hidden content is never served again. Log rows hold
// key, op and version only; a pull reads the record as it is now. Tombstones
// last 30 days, and an older cursor gets a snapshot.

import test from "ava";

import type { FollowUpRec, LogId, ReplyRec, ThreadRec } from "../src/index.js";

import { DAY, HOUR, actor, cast, ok, refused, thread } from "./harness.js";
import { diff, expected } from "./oracle.js";

const SECRET = "the text that must not come back";

test("after a hide, pulls and snapshots carry the thread without its text, for every reader", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  const readers = ["mel", "mona", "olga", "otto", "eve", null].map((u) => w.client(u));
  for (const c of readers) await c.sync(`space:${open}`);
  t.is((readers[0]?.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
  await ok(t, w.as("mona", "moderation.decide", { item: `p:${th}`, decision: "hidden" }));
  for (const c of readers) {
    t.is(await c.sync(`space:${open}`), "pull");
    const p = c.records(`space:${open}`).get(`thread:${th}`) as ThreadRec;
    t.is(p.mod, "hidden");
    t.is(p.q, "");
    const snap = await w.server.snapshot(c.actor, `space:${open}`);
    t.false(JSON.stringify(snap).includes(SECRET));
    t.false(JSON.stringify([...c.records(`space:${open}`)]).includes(SECRET));
  }
  // a moderator may show a hidden item again (the mock's "shown"); its text is
  // served from then on, never while it is hidden
  await ok(t, w.as("mona", "moderation.decide", { item: `p:${th}`, decision: "shown" }));
  await readers[0]?.sync(`space:${open}`);
  t.is((readers[0]?.records(`space:${open}`).get(`thread:${th}`) as ThreadRec).q, SECRET);
});

test("after a removal, the text is never served again, whatever happens next", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "mel", closed, "ask", SECRET);
  const mel = w.client("mel");
  const mona = w.client("mona");
  await mel.sync(`space:${closed}`);
  await mona.sync(`space:${closed}`);
  await ok(t, w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  await refused(
    t,
    w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "shown" }),
    "PRECONDITION_FAILED",
  );
  await refused(
    t,
    w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }),
    "PRECONDITION_FAILED",
  );
  // the author edits it, people like it, follow up on it: it stays without text
  await ok(t, w.as("mel", "threads.update", { id: th, q: `${SECRET} (edited)` }));
  await ok(t, w.as("ada", "likes.set", { thread: th, on: true }));
  await ok(t, w.as("ada", "followups.ask", { id: w.id(), thread: th, q: "why?" }));
  for (const c of [mel, mona]) {
    await c.sync(`space:${closed}`);
    t.false(JSON.stringify([...c.records(`space:${closed}`)]).includes(SECRET));
    t.false(JSON.stringify(await w.server.snapshot(c.actor, `space:${closed}`)).includes(SECRET));
  }
  const p = mel.records(`space:${closed}`).get(`thread:${th}`) as ThreadRec;
  t.is(p.mod, "removed");
  t.is(p.likes, 1);
  t.is(p.r, 1);
});

test("hidden follow-ups and replies lose their text too", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const post = await thread(t, w, "mel", open, "post");
  const fu = w.id();
  const rp = w.id();
  await ok(t, w.as("otto", "followups.ask", { id: fu, thread: ask, q: SECRET }));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rp, thread: post, t: SECRET }));
  const c = w.client(null);
  await c.sync(`space:${open}`);
  await ok(t, w.as("mona", "moderation.decide", { item: `f:${ask}:${fu}`, decision: "hidden" }));
  await ok(t, w.as("mona", "moderation.decide", { item: `r:${post}:${rp}`, decision: "removed" }));
  await c.sync(`space:${open}`);
  t.is((c.records(`space:${open}`).get(`followup:${fu}`) as FollowUpRec).q, "");
  t.is((c.records(`space:${open}`).get(`reply:${rp}`) as ReplyRec).t, "");
  t.false(JSON.stringify(await w.server.snapshot(actor("otto"), `space:${open}`)).includes(SECRET));
  // a key that names the item under another thread is NOT_FOUND
  await refused(
    t,
    w.as("mona", "moderation.decide", { item: `f:${post}:${fu}`, decision: "hidden" }),
    "NOT_FOUND",
  );
});

test("an author's delete takes the text out of what is served", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  await ok(t, w.as("otto", "likes.set", { thread: th, on: true }));
  await ok(t, w.as("otto", "saved.toggle", { kind: "thread", id: th }));
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
  t.false(JSON.stringify([...w.server.dump()]).includes(SECRET));
});

test("an old cursor resyncs into the current state, never the content it last saw", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", SECRET);
  const eve = w.client("eve");
  await eve.sync(`space:${open}`);
  await ok(t, w.as("mona", "moderation.decide", { item: `p:${th}`, decision: "removed" }));
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
  await ok(t, w.as("olga", "members.remove", { space: closed, user: "mona" }));
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
  await ok(t, w.as("mel", "threads.update", { id: th, q: "second" }));
  await ok(t, w.as("mel", "threads.update", { id: th, q: "third" }));
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
