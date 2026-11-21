// The M1b reviews' findings, as tests of the server half, so the acceptance
// suite itself detects them (the mutators package's tests are not the
// acceptance suite): the run queue limit and its reason, frozen spaces,
// forks under unfinished parents, look-up boundaries, promotion and the
// removal of its copies, reply and comment shells, deletes with the
// author's own items under them, a stale retry, mentions with trailing
// punctuation and the record shapes of the M1a review (items 1, 2, 7, 8, 9).

import test from "ava";

import type { StoredRecord } from "../src/index.js";

import {
  MODEL,
  actor,
  answer,
  bare,
  cast,
  fork,
  forkInput,
  ok,
  refused,
  thread,
  threadInput,
} from "./harness.js";

type Rec<K extends StoredRecord["kind"]> = Extract<StoredRecord, { kind: K }>;

test("the 21st queued run is PRECONDITION_FAILED with reason queue_full, recorded", async (t) => {
  const { w, open } = await cast(t);
  for (let k = 0; k < 20; k++)
    await ok(t, w.as("mel", "threads.create", threadInput(w.id(), open, "ask", `q${k}`)));
  const e = await w.envelope("mel", "threads.create", threadInput(w.id(), open, "ask", "one more"));
  const r = await w.server.apply(actor("mel"), e);
  await refused(t, r, "PRECONDITION_FAILED");
  t.is(r.ok ? undefined : r.error.reason, "queue_full");
  // recorded: the same envelope gets the same answer, reason included
  t.deepEqual(bare(await w.resend("mel", e)), bare(r));
  // a post queues no run; another person's queue is their own
  await ok(t, w.as("mel", "threads.create", threadInput(w.id(), open, "post", "a post")));
  await ok(t, w.as("mona", "threads.create", threadInput(w.id(), open, "ask", "mine")));
  // a finished run leaves the queue: room for one more
  const queued = [...w.server.dump().values()].find(
    (x): x is Rec<"run"> => x.kind === "run" && x.u === "mel" && x.status === "queued",
  );
  await answer(w, `thread:${queued?.th ?? ""}`);
  await ok(t, w.as("mel", "threads.create", threadInput(w.id(), open, "ask", "now")));
});

test("a frozen space is readable and refuses every write but deleting one's own items, leaving and user-log writes", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const p = await thread(t, w, "mel", open, "post", "Hi @otto");
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: p, on: true }));
  const rep = w.id();
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: rep, thread: p, t: "x" }));
  t.true(await w.server.freeze(open));
  t.like(w.get(`space:${open}`), { frozen: true });
  for (const [u, name, input] of [
    ["mona", "threads.create", threadInput(w.id(), open, "post", "x")],
    ["otto", "research.forkNode", forkInput(w.id(), ask, "x")],
    ["otto", "comments.create", { id: w.id(), thread: ask, node: "r", t: "x" }],
    ["olga", "spaces.update", { id: open, desc: "x" }],
    ["olga", "members.ban", { space: open, user: "otto" }],
    ["eve", "spaces.join", { space: open }],
  ] as const)
    await refused(t, w.as(u, name, input), "FORBIDDEN");
  // readable as before
  const snap = await w.server.snapshot(null, `space:${open}`);
  t.true(snap.records.some((x) => x.key === `thread:${p}`));
  // allowed: deleting one's own items, leaving, the person's own records
  // (saves and notifications are user-log records)
  await ok(t, w.as("mona", "saved.set", { kind: "thread", id: p, on: true }));
  await ok(t, w.as("otto", "replies.delete", { id: rep }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: p, on: false }));
  const n = w.notifs("otto").find((x) => x.type === "mention");
  await ok(t, w.as("otto", "notifications.markRead", { id: n?.id ?? "" }));
  await ok(t, w.as("mel", "threads.delete", { id: ask }));
  await ok(t, w.as("mona", "spaces.leave", { space: open }));
});

test("an ask is forked only under a parent whose run has ended", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask", "q", true);
  // the root's run is queued
  await refused(
    t,
    w.as("mona", "research.forkNode", forkInput(w.id(), ask, "x")),
    "PRECONDITION_FAILED",
  );
  // running
  const run = [...w.server.dump().values()].find(
    (x): x is Rec<"run"> => x.kind === "run" && x.th === ask && x.node === "r",
  );
  t.truthy(run);
  await ok(t, w.as("mel", "research.cancelNode", { thread: ask, node: "r" }));
  // a run that stopped: forked under (the parent's run has ended)
  const n = w.id();
  await ok(t, w.as("mona", "research.forkNode", forkInput(n, ask, "after the stop")));
  // under the new node, whose run is queued: refused until it finishes
  await refused(
    t,
    w.as("otto", "research.forkNode", forkInput(w.id(), ask, "too soon", n)),
    "PRECONDITION_FAILED",
  );
  await answer(w, `node:${n}`);
  await ok(t, w.as("otto", "research.forkNode", forkInput(w.id(), ask, "now", n)));
});

test("a look-up needs its quote, and its phrase whole words of it, combining marks included", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const look = (id: string, phrase: string, quote?: string) => ({
    id,
    thread: ask,
    parent: "r",
    kind: "lookup",
    look: phrase,
    ...(quote === undefined ? {} : { quote }),
    ...MODEL,
  });
  const q = "Un café noir, and a tide gauge.";
  await refused(t, w.as("mona", "research.forkNode", look(w.id(), "tide gauge")), "BAD_REQUEST");
  await refused(t, w.as("mona", "research.forkNode", look(w.id(), "ide gauge", q)), "BAD_REQUEST");
  await refused(t, w.as("mona", "research.forkNode", look(w.id(), "cafe", q)), "BAD_REQUEST");
  const id = w.id();
  await ok(t, w.as("mona", "research.forkNode", look(id, "«café»", q)));
  t.like(w.get(`node:${id}`), { k: "lookup", look: "café", tpl: 1, quote: q });
  // an ask node has no phrase and no template (M1a review 7)
  const n = await fork(t, w, "otto", ask);
  t.like(w.get(`node:${n}`), { k: "ask", look: null, tpl: null });
});

test("a branch opened as its own thread names its source, and is removed with it", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const n = await fork(t, w, "mona", ask, "the branch");
  // a hidden branch is not opened as its own thread
  const hidden = await fork(t, w, "mona", ask, "hidden");
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `f:${ask}:${hidden}`,
      decision: "hidden",
      base: w.item(`f:${ask}:${hidden}`),
    }),
  );
  await refused(
    t,
    w.as("otto", "threads.create", { id: w.id(), from: { th: ask, node: hidden } }),
    "PRECONDITION_FAILED",
  );
  const copy = w.id();
  await ok(t, w.as("otto", "threads.create", { id: copy, from: { th: ask, node: n } }));
  // M1a review 1 and 8: the copy names its source, the node its copy, and
  // the copied answer is the root's
  t.like(w.get(`thread:${copy}`), { from: { th: ask, node: n }, u: "mona", k: "ask" });
  t.like(w.get(`node:${n}`), { promoted: copy });
  t.like(w.get(`answer:${copy}`), { node: "r", th: copy });
  await refused(
    t,
    w.as("otto", "threads.create", { id: w.id(), from: { th: ask, node: n } }),
    "PRECONDITION_FAILED",
  );
  // the node's removal removes the copy too (M1b review 14), with the
  // placeholder of a removed thread (M1a review 2)
  await ok(
    t,
    w.as("olga", "moderation.decide", { item: `f:${ask}:${n}`, decision: "removed", note: "no" }),
  );
  t.like(w.get(`thread:${copy}`), {
    mod: "removed",
    q: "",
    t: null,
    sum: null,
    tok: 0,
    src: 0,
    model: null,
    effort: null,
    from: null,
  });
  t.is(w.get(`answer:${copy}`), undefined);
});

test("a reply or comment shell is not edited, and a delete with only the author's own under it erases them", async (t) => {
  // M1a review 9; M1b review 9
  const { w, open } = await cast(t);
  const p = await thread(t, w, "mel", open, "post");
  const top = w.id();
  const sub = w.id();
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: top, thread: p, t: "top" }));
  await ok(
    t,
    w.as("mona", "research.createPostFollowUp", { id: sub, thread: p, t: "s", parent: top }),
  );
  t.deepEqual(await ok(t, w.as("otto", "replies.delete", { id: top })), { kept: true });
  t.like(w.get(`reply:${top}`), { t: "", del: true });
  await refused(
    t,
    w.as("otto", "replies.update", { id: top, t: "back", base: { rev: w.rev(`reply:${top}`) } }),
    "PRECONDITION_FAILED",
  );
  const ask = await thread(t, w, "mel", open, "ask");
  const c = w.id();
  await ok(t, w.as("otto", "comments.create", { id: c, thread: ask, node: "r", t: "c" }));
  await ok(
    t,
    w.as("mona", "comments.create", { id: w.id(), thread: ask, node: "r", t: "d", parent: c }),
  );
  t.deepEqual(await ok(t, w.as("otto", "comments.delete", { id: c })), { kept: true });
  t.like(w.get(`comment:${c}`), { t: "", del: true });
  await refused(
    t,
    w.as("otto", "comments.update", { id: c, t: "back", base: { rev: w.rev(`comment:${c}`) } }),
    "PRECONDITION_FAILED",
  );
  // only the author's own under it: all of it goes, and the count with it
  const own = w.id();
  const ownSub = w.id();
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: own, thread: p, t: "o" }));
  await ok(
    t,
    w.as("otto", "research.createPostFollowUp", { id: ownSub, thread: p, t: "p", parent: own }),
  );
  const r = (w.get(`counts:${p}`) as Rec<"counts">).r;
  t.deepEqual(await ok(t, w.as("otto", "replies.delete", { id: own })), { kept: false });
  t.is(w.get(`reply:${own}`), undefined);
  t.is(w.get(`reply:${ownSub}`), undefined);
  t.is((w.get(`counts:${p}`) as Rec<"counts">).r, r - 2);
  // a node with only its author's nodes and comments under it goes with
  // them, their answers and run records
  const n = await fork(t, w, "mona", ask, "n");
  const m = await fork(t, w, "mona", ask, "m", n);
  const nc = w.id();
  await ok(t, w.as("mona", "comments.create", { id: nc, thread: ask, node: m, t: "mine" }));
  t.deepEqual(await ok(t, w.as("mona", "followups.delete", { thread: ask, node: n })), {
    kept: false,
  });
  for (const k of [`node:${n}`, `node:${m}`, `answer:${n}`, `answer:${m}`, `comment:${nc}`])
    t.is(w.get(k), undefined, k);
  t.false(
    [...w.server.dump().values()].some((x) => x.kind === "run" && (x.node === n || x.node === m)),
  );
});

test("a retry made for an attempt that was retried since is STALE", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask", "q", true);
  await ok(t, w.as("mel", "research.cancelNode", { thread: ask, node: "r" }));
  const retry = (attempt: number) =>
    w.as("mel", "research.retryNode", { thread: ask, node: "r", ...MODEL, base: { attempt } });
  await ok(t, retry(1));
  await ok(t, w.as("mel", "research.cancelNode", { thread: ask, node: "r" }));
  // a second device's retry, made when it saw attempt 1 stop
  await refused(t, retry(1), "STALE");
  await ok(t, retry(2));
});

test("a mention's trailing . _ or - is punctuation", async (t) => {
  const { w, open } = await cast(t);
  const p = w.id();
  const r = await ok(
    t,
    w.as("mel", "threads.create", threadInput(p, open, "post", "Thanks @otto_ and @mona-.")),
  );
  t.like(r, { notified: ["otto", "mona"], notMembers: [] });
});

test("replies and comments nest to any depth; a removal erases what is under it and a delete keeps a shell for another's grandchild", async (t) => {
  const { w, open } = await cast(t);
  const p = await thread(t, w, "mel", open, "post");
  const chain = async (people: string[], parent?: string) => {
    const ids: string[] = [];
    let up = parent;
    for (const u of people) {
      const id = w.id();
      await ok(
        t,
        w.as(u, "research.createPostFollowUp", {
          id,
          thread: p,
          t: `by ${u}`,
          ...(up ? { parent: up } : {}),
        }),
      );
      ids.push(id);
      up = id;
    }
    return ids;
  };
  // three levels deep, and a fourth
  const [, b, c, d] = await chain(["otto", "mona", "otto", "mel"]);
  t.like(w.get(`reply:${d}`), { parent: c });
  t.is((w.get(`counts:${p}`) as Rec<"counts">).r, 4);
  await ok(t, w.as("olga", "moderation.decide", { item: `r:${p}:${b}`, decision: "removed" }));
  t.is(w.get(`reply:${c}`), undefined);
  t.is(w.get(`reply:${d}`), undefined);
  t.is((w.get(`counts:${p}`) as Rec<"counts">).r, 2);
  const [e, f, g] = await chain(["otto", "otto", "mona"]);
  t.deepEqual(await ok(t, w.as("otto", "replies.delete", { id: e ?? "" })), { kept: true });
  t.like(w.get(`reply:${e}`), { t: "", del: true });
  t.truthy(w.get(`reply:${f}`));
  t.truthy(w.get(`reply:${g}`));
  // comments: three deep on one node
  const ask = await thread(t, w, "mel", open, "ask");
  let up: string | undefined;
  for (const u of ["otto", "mona", "otto"]) {
    const id = w.id();
    await ok(
      t,
      w.as(u, "comments.create", {
        id,
        thread: ask,
        node: "r",
        t: u,
        ...(up ? { parent: up } : {}),
      }),
    );
    up = id;
  }
  t.like(w.get(`comment:${up ?? ""}`), { u: "otto" });
});

test("answers under (client, seq) expire after 7 days like those under (user, mutation id)", async (t) => {
  // N15 on the sync server: a pruned table is seen only at rest
  const { w, open } = await cast(t);
  const p = await thread(t, w, "mel", open, "post");
  const e = await w.envelope(
    "otto",
    "saved.set",
    { kind: "thread", id: p, on: true },
    "not-a-ulid",
  );
  await refused(t, w.server.apply(actor("otto"), e), "BAD_REQUEST");
  const bySeq = async () => (await w.server.scanStorage()).answers.filter((a) => a.clientId);
  t.is((await bySeq()).length, 1);
  w.clock.advance(7 * 86_400_000 - 1);
  t.is((await bySeq()).length, 1);
  w.clock.advance(1);
  t.is((await bySeq()).length, 0);
});
