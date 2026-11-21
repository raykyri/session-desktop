// The M1a review's findings on erasure and notifications (items 12, 13, 17
// and 18), as tests of the server half.

import test from "ava";

import { LOOKUP_PROMPT_V1, type StoredRecord } from "../src/index.js";

import { MODEL, answer, cast, fork, ok, refused, thread } from "./harness.js";

type Rec<K extends StoredRecord["kind"]> = Extract<StoredRecord, { kind: K }>;

test("an ask deleted with only comments under it stays as a shell, and its comments with it", async (t) => {
  // item 12: comments count for `kept`, so they are never left stored and
  // served under a thread that is gone
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const c = w.id();
  await ok(t, w.as("otto", "comments.create", { id: c, thread: ask, node: "r", t: "a comment" }));
  t.deepEqual(await ok(t, w.as("mel", "threads.delete", { id: ask })), { kept: true });
  t.like(w.get(`thread:${ask}`), { del: true, gone: false, q: "" });
  t.truthy(w.get(`comment:${c}`));
});

test("removing a node erases the nodes under it with their answers, comments and runs, and its own runs", async (t) => {
  // item 13
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const top = await fork(t, w, "mona", ask, "top");
  const mid = await fork(t, w, "otto", ask, "mid", top);
  const low = w.id();
  // its run is queued: a dispatcher would spend tokens on erased text
  await ok(
    t,
    w.as("mel", "research.forkNode", {
      id: low,
      thread: ask,
      parent: mid,
      kind: "ask",
      q: "low",
      ...MODEL,
    }),
  );
  t.true(w.server.jobs().some((j) => (w.get(`run:${j.id}`) as Rec<"run">).node === low));
  const c = w.id();
  await ok(t, w.as("mel", "comments.create", { id: c, thread: ask, node: mid, t: "under" }));
  const side = await fork(t, w, "mel", ask, "side");
  await ok(t, w.as("olga", "moderation.decide", { item: `f:${ask}:${top}`, decision: "removed" }));
  t.like(w.get(`node:${top}`), { mod: "removed", q: "" });
  for (const key of [
    `node:${mid}`,
    `node:${low}`,
    `answer:${top}`,
    `answer:${mid}`,
    `comment:${c}`,
  ])
    t.is(w.get(key), undefined, key);
  const runs = [...w.server.dump().values()].filter((r): r is Rec<"run"> => r.kind === "run");
  t.deepEqual(
    runs.filter((r) => [top, mid, low].includes(r.node)),
    [],
  );
  t.true(w.server.jobs().every((j) => (w.get(`run:${j.id}`) as Rec<"run">).node !== low));
  // the rest of the thread stays, and the count follows
  t.truthy(w.get(`node:${side}`));
  t.like(w.get(`counts:${ask}`), { r: 2 });
});

test("removing a reply, a comment or a node erases the mention notifications that point at it", async (t) => {
  // item 17
  const { w, open } = await cast(t);
  const mentions = () =>
    w
      .notifs("mona")
      .filter((n) => n.type === "mention")
      .map((n) => n.item);
  const post = await thread(t, w, "mel", open, "post");
  const reply = w.id();
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: reply, thread: post, t: "@mona" }));
  const ask = await thread(t, w, "mel", open, "ask");
  const c = w.id();
  await ok(t, w.as("otto", "comments.create", { id: c, thread: ask, node: "r", t: "@mona" }));
  const n = await fork(t, w, "mel", ask, "a node");
  const under = w.id();
  await ok(t, w.as("otto", "comments.create", { id: under, thread: ask, node: n, t: "@mona" }));
  t.deepEqual(mentions(), [`reply:${reply}`, `comment:${c}`, `comment:${under}`]);
  await ok(
    t,
    w.as("olga", "moderation.decide", { item: `r:${post}:${reply}`, decision: "removed" }),
  );
  t.deepEqual(mentions(), [`comment:${c}`, `comment:${under}`]);
  await ok(t, w.as("olga", "moderation.decide", { item: `c:${ask}:${c}`, decision: "removed" }));
  t.deepEqual(mentions(), [`comment:${under}`]);
  await ok(t, w.as("olga", "moderation.decide", { item: `f:${ask}:${n}`, decision: "removed" }));
  t.deepEqual(mentions(), []);
});

test("a branch and a comment notify the node's author, a person cannot mark another's notification read, and a look-up's prompt is v1 of its phrase", async (t) => {
  // item 18
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const node = await fork(t, w, "mona", ask, "mona's");
  // otto continues under mona's node: mona, not mel, is told
  const next = w.id();
  await ok(
    t,
    w.as("otto", "research.forkNode", {
      id: next,
      thread: ask,
      parent: node,
      kind: "ask",
      q: "and?",
      ...MODEL,
    }),
  );
  const branch = w.notifs("mona").filter((n) => n.type === "branch");
  t.deepEqual(
    branch.map((n) => [n.item, n.actor]),
    [[`node:${next}`, "otto"]],
  );
  t.false(w.notifs("mel").some((n) => n.type === "branch" && n.item === `node:${next}`));
  // a comment on mona's node: mona is told
  const c = w.id();
  await ok(t, w.as("otto", "comments.create", { id: c, thread: ask, node, t: "nice" }));
  t.deepEqual(
    w
      .notifs("mona")
      .filter((n) => n.type === "comment")
      .map((n) => n.item),
    [`comment:${c}`],
  );
  t.false(w.notifs("mel").some((n) => n.type === "comment"));
  // otto cannot mark mona's notification read
  const mine = w.notifs("mona")[0];
  await refused(t, w.as("otto", "notifications.markRead", { id: mine?.id ?? "" }), "NOT_FOUND");
  t.false((w.get(`notif:${mine?.id ?? ""}`) as Rec<"notif">).read);
  // a look-up stores v1 of its phrase as its prompt
  const look = w.id();
  await ok(
    t,
    w.as("otto", "research.forkNode", {
      id: look,
      thread: ask,
      parent: "r",
      kind: "lookup",
      look: " tide gauge, ",
      quote: "Each tide gauge records the sea level.",
      ...MODEL,
    }),
  );
  t.is((w.get(`node:${look}`) as Rec<"node">).q, LOOKUP_PROMPT_V1("tide gauge"));
  await answer(w, `node:${look}`);
});
