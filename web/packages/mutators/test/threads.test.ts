// Threads (`03` G1, G5; `01` C15): an ask queues its root run, a post
// notifies its mentions, the author edits and deletes, a node opens as its
// own thread.

import test from "ava";

import { MODEL, ask, cast, finish, fork, ok, post, refused } from "./world.js";

test("an ask writes its thread, counts and a queued root run, the run record being the queue", (t) => {
  const { w, open } = cast(t);
  const id = w.id();
  const r = ok(
    t,
    w.apply("mel", "threads.create", { id, space: open, kind: "ask", q: " Why? ", ...MODEL }),
  ) as {
    id: string;
    run: string;
  };
  t.is(r.id, id);
  t.like(w.get(`thread:${id}`), { u: "mel", k: "ask", q: "Why?", running: true, ...MODEL });
  t.like(w.get(`counts:${id}`), { saves: 0, r: 0 });
  t.like(w.get(`run:${r.run}`), {
    th: id,
    node: "r",
    u: "mel",
    status: "queued",
    attempt: 1,
    step: 0,
    ...MODEL,
  });
  t.like(w.get(`stats:${open}`), { posts: 1 });
});

test("a post writes no run, notifies the accounts it mentions that may read it, and says who", (t) => {
  const { w, open, closed } = cast(t);
  const id = w.id();
  const r = ok(
    t,
    w.apply("mel", "threads.create", {
      id,
      space: open,
      kind: "post",
      q: "Hi @mona @eve @mel @nobody",
    }),
  );
  t.is(w.all("run").length, 0);
  // eve, an account who has not joined the open space, is notified too; the
  // author is not; nobody is no account (02 N16, M1a review 11)
  t.deepEqual(
    w.all("notif").map((n) => [n.to, n.type, n.item]),
    [
      ["mona", "mention", `thread:${id}`],
      ["eve", "mention", `thread:${id}`],
    ],
  );
  t.deepEqual(r, { id, run: null, notified: ["mona", "eve"], notMembers: ["nobody"] });
  // in a private space only its members are notified; eve is an account
  // who may not read it, so she is neither notified nor reported
  const p = w.id();
  const q = ok(
    t,
    w.apply("ada", "threads.create", { id: p, space: closed, kind: "post", q: "@olga @eve @x" }),
  );
  t.deepEqual(q, { id: p, run: null, notified: ["olga"], notMembers: ["x"] });
  // the client's prediction names none: they are server values
  const { prediction } = w.predict("ada", "threads.create", {
    id: w.id(),
    space: closed,
    kind: "post",
    q: "@olga",
  });
  t.like(prediction, { ok: true, result: { notified: [], notMembers: [] } });
});

test("nobody is notified who may not read the space when the write commits", (t) => {
  // M1a review 16: a reply, a branch, a comment or a removal to a person
  // removed from the private space
  const { w, closed } = cast(t);
  const p = w.id();
  ok(t, w.apply("ada", "threads.create", { id: p, space: closed, kind: "post", q: "x" }));
  const a = w.id();
  ok(t, w.apply("ada", "threads.create", { id: a, space: closed, kind: "ask", q: "x", ...MODEL }));
  finish(w, a, "r");
  const adm = (w.get(`member:${closed}:ada`) as { adm: string }).adm;
  ok(t, w.apply("olga", "members.remove", { space: closed, user: "ada", base: { adm } }));
  ok(t, w.apply("olga", "research.createPostFollowUp", { id: w.id(), thread: p, t: "x" }));
  ok(
    t,
    w.apply("olga", "research.forkNode", {
      id: w.id(),
      thread: a,
      parent: "r",
      kind: "ask",
      q: "y",
      ...MODEL,
    }),
  );
  ok(t, w.apply("olga", "comments.create", { id: w.id(), thread: a, node: "r", t: "z" }));
  ok(t, w.apply("olga", "moderation.decide", { item: `p:${p}`, decision: "removed" }));
  t.deepEqual(w.notifs("ada"), []);
});

test("an author's edit compares the thread's rev", (t) => {
  const { w, open } = cast(t);
  const id = post(t, w, "mel", open);
  const rev = w.rev(`thread:${id}`);
  refused(t, w.apply("mona", "threads.update", { id, q: "x", base: { rev } }), "FORBIDDEN");
  ok(t, w.apply("mel", "threads.update", { id, q: "Edited", base: { rev } }));
  t.like(w.get(`thread:${id}`), { q: "Edited", edited: true });
  refused(t, w.apply("mel", "threads.update", { id, q: "Again", base: { rev } }), "STALE");
});

test("a deleted thread with replies stays as a shell; one without is gone and leaves Saved", (t) => {
  const { w, open } = cast(t);
  const kept = post(t, w, "mel", open);
  const lone = post(t, w, "mel", open);
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: w.id(), thread: kept, t: "x" }));
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: lone, on: true }));
  t.deepEqual(ok(t, w.apply("mel", "threads.delete", { id: kept })), { kept: true });
  t.deepEqual(ok(t, w.apply("mel", "threads.delete", { id: lone })), { kept: false });
  t.like(w.get(`thread:${kept}`), { del: true, gone: false, q: "" });
  t.like(w.get(`thread:${lone}`), { del: true, gone: true, q: "" });
  t.is(w.get(`save:otto:${lone}`), undefined);
});

test("nothing is added to a gone thread: replies, nodes, comments and saves (M1b review 10)", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const a = ask(t, w, "mel", open);
  ok(t, w.apply("mel", "threads.delete", { id: p }));
  ok(t, w.apply("mel", "threads.delete", { id: a }));
  t.like(w.get(`thread:${a}`), { gone: true });
  const gone = (u: string, name: string, input: unknown) =>
    t.like(refused(t, w.apply(u, name, input), "PRECONDITION_FAILED"), {
      message: "This thread was deleted.",
    });
  gone("otto", "research.createPostFollowUp", { id: w.id(), thread: p, t: "late" });
  gone("otto", "saved.set", { kind: "thread", id: p, on: true });
  gone("otto", "research.forkNode", {
    id: w.id(),
    thread: a,
    parent: "r",
    kind: "ask",
    q: "late",
    ...MODEL,
  });
  gone("otto", "comments.create", { id: w.id(), thread: a, node: "r", t: "late" });
  // taking a save back still works
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: false }));
});

test("G5: opening a branch as its own thread copies its question and answer and starts no run", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const node = fork(t, w, "mona", th);
  const runs = w.all("run").length;
  const id = w.id();
  // otto, who did not write the branch, opens it: the thread is mona's
  t.deepEqual(ok(t, w.apply("otto", "threads.create", { id, from: { th, node } })), {
    id,
    run: null,
    notified: [],
    notMembers: [],
  });
  t.is(w.all("run").length, runs);
  t.like(w.get(`thread:${id}`), {
    s: open,
    u: "mona",
    k: "ask",
    q: "And?",
    running: false,
    tok: 1200,
    src: 1,
    ...MODEL,
  });
  t.like(w.get(`node:${node}`), { promoted: id });
  const a = w.get(`answer:${id}`);
  // the root's answer: `node: "r"`, keyed by the new thread
  t.like(a, { node: "r", th: id, u: "mona", md: (w.get(`answer:${node}`) as { md: string }).md });
  t.like(w.get(`thread:${id}`), { from: { th, node } });
  t.like(w.get(`stats:${open}`), { posts: 2 });
  // once only
  refused(
    t,
    w.apply("otto", "threads.create", { id: w.id(), from: { th, node } }),
    "PRECONDITION_FAILED",
  );
});

test("G5: a branch without an answer, a hidden one, or one the person may not read is not opened", (t) => {
  const { w, open, closed } = cast(t);
  const th = ask(t, w, "mel", open);
  const pending = fork(t, w, "mona", th, "r", false);
  refused(
    t,
    w.apply("otto", "threads.create", { id: w.id(), from: { th, node: pending } }),
    "PRECONDITION_FAILED",
  );
  const hidden = fork(t, w, "mona", th);
  ok(t, w.apply("olga", "moderation.decide", { item: `f:${th}:${hidden}`, decision: "hidden" }));
  refused(
    t,
    w.apply("otto", "threads.create", { id: w.id(), from: { th, node: hidden } }),
    "PRECONDITION_FAILED",
  );
  // a node of another thread
  const other = ask(t, w, "mel", open);
  refused(
    t,
    w.apply("otto", "threads.create", { id: w.id(), from: { th: other, node: hidden } }),
    "NOT_FOUND",
  );
  // a private space's branch, for a person outside it
  const secret = ask(t, w, "ada", closed);
  const n = fork(t, w, "ada", secret);
  refused(
    t,
    w.apply("eve", "threads.create", { id: w.id(), from: { th: secret, node: n } }),
    "NOT_FOUND",
  );
  // the input names no kind, text, model or space
  refused(
    t,
    w.apply("otto", "threads.create", { id: w.id(), from: { th, node: hidden }, q: "mine" }),
    "BAD_REQUEST",
  );
  finish(w, th, pending);
  ok(t, w.apply("otto", "threads.create", { id: w.id(), from: { th, node: pending } }));
});
