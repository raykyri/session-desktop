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

test("a post writes no run and notifies the members it mentions, not its author", (t) => {
  const { w, open } = cast(t);
  const id = post(t, w, "mel", open, "Hi @mona @eve @mel");
  t.is(w.all("run").length, 0);
  t.deepEqual(
    w.all("notif").map((n) => [n.to, n.type, n.item]),
    [["mona", "mention", `thread:${id}`]],
  );
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
  t.like(a, { node: id, th: id, u: "mona", md: (w.get(`answer:${node}`) as { md: string }).md });
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
