// Ask nodes and runs (`03` G1, G2, G6, E4, L1, K13).

import test from "ava";

import { LOOKUP_PROMPT_V1, QUEUED_RUNS_MAX } from "../src/index.js";

import { MODEL, ask, cast, finish, fork, ok, refused } from "./world.js";

const input = (thread: string, id: string, parent = "r") => ({
  id,
  thread,
  parent,
  kind: "ask",
  q: "More?",
  ...MODEL,
});

test("G1: a fork writes its node, a queued run and the parent author's branch notification in one write", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const id = w.id();
  const r = ok(t, w.apply("mona", "research.forkNode", input(th, id))) as {
    id: string;
    run: string;
  };
  t.is(r.id, id);
  t.like(w.get(`node:${id}`), {
    th,
    par: "r",
    k: "ask",
    u: "mona",
    q: "More?",
    run: r.run,
    ...MODEL,
  });
  t.like(w.get(`run:${r.run}`), { node: id, status: "queued", u: "mona", ...MODEL });
  t.like(w.get(`counts:${th}`), { r: 1 });
  t.deepEqual(
    w.notifs("mel").map((n) => [n.type, n.item, n.actor, n.n]),
    [["branch", `node:${id}`, "mona", 1]],
  );
});

test("G7: a hidden parent takes forks from its author and the space's owner only", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = ok(t, w.apply("mona", "research.forkNode", input(th, w.id()))) as { id: string };
  finish(w, th, n.id);
  ok(t, w.apply("olga", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  ok(t, w.apply("olga", "moderation.decide", { item: `f:${th}:${n.id}`, decision: "hidden" }));
  refused(t, w.apply("otto", "research.forkNode", input(th, w.id())), "PRECONDITION_FAILED");
  refused(t, w.apply("mel", "research.forkNode", input(th, w.id(), n.id)), "PRECONDITION_FAILED");
  ok(t, w.apply("mel", "research.forkNode", input(th, w.id())));
  ok(t, w.apply("mona", "research.forkNode", input(th, w.id(), n.id)));
  ok(t, w.apply("olga", "research.forkNode", input(th, w.id(), n.id)));
});

test("G1: the parent exists, is readable, is not removed, and its run has ended", (t) => {
  const { w, open, closed } = cast(t);
  const th = ask(t, w, "mel", open, false);
  // the root's run is queued: no Continue or Branch under it yet
  refused(t, w.apply("mona", "research.forkNode", input(th, w.id())), "PRECONDITION_FAILED");
  finish(w, th, "r");
  const n = ok(t, w.apply("mona", "research.forkNode", input(th, w.id()))) as { id: string };
  // under a node whose run is queued, then running
  refused(t, w.apply("otto", "research.forkNode", input(th, w.id(), n.id)), "PRECONDITION_FAILED");
  const run = w.all("run").find((x) => x.node === n.id);
  if (run) w.put({ ...run, status: "running" });
  refused(t, w.apply("otto", "research.forkNode", input(th, w.id(), n.id)), "PRECONDITION_FAILED");
  finish(w, th, n.id);
  ok(t, w.apply("otto", "research.forkNode", input(th, w.id(), n.id)));
  // a missing parent, one of another thread, one the person may not read
  refused(t, w.apply("otto", "research.forkNode", input(th, w.id(), w.id())), "NOT_FOUND");
  const other = ask(t, w, "mel", open);
  refused(t, w.apply("otto", "research.forkNode", input(other, w.id(), n.id)), "NOT_FOUND");
  const secret = ask(t, w, "ada", closed);
  refused(t, w.apply("eve", "research.forkNode", input(secret, w.id())), "NOT_FOUND");
  // a removed parent
  ok(t, w.apply("olga", "moderation.decide", { item: `f:${th}:${n.id}`, decision: "removed" }));
  refused(t, w.apply("otto", "research.forkNode", input(th, w.id(), n.id)), "PRECONDITION_FAILED");
  // a post has no nodes
  const p = w.id();
  ok(t, w.apply("mel", "threads.create", { id: p, space: open, kind: "post", q: "x" }));
  refused(t, w.apply("otto", "research.forkNode", input(p, w.id())), "BAD_REQUEST");
});

test("the model must be in the registry and the effort one it accepts", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  for (const bad of [
    { model: "claude-fable-5-1", effort: "medium" },
    { model: "gemini-flash", effort: "max" },
    { model: "m", effort: "low" },
  ]) {
    refused(
      t,
      w.apply("mona", "research.forkNode", { ...input(th, w.id()), ...bad }),
      "BAD_REQUEST",
    );
    refused(
      t,
      w.apply("mona", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x", ...bad }),
      "BAD_REQUEST",
    );
  }
  refused(
    t,
    w.apply("mona", "research.forkNode", { ...input(th, w.id()), effort: undefined }),
    "BAD_REQUEST",
  );
  ok(
    t,
    w.apply("mona", "research.forkNode", {
      ...input(th, w.id()),
      model: "gemini-flash",
      effort: "high",
    }),
  );
});

test("L1: the 21st queued run of a person is PRECONDITION_FAILED with reason queue_full", (t) => {
  const { w, open } = cast(t);
  for (let k = 0; k < QUEUED_RUNS_MAX; k++) ask(t, w, "mel", open, false);
  const e = refused(
    t,
    w.apply("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x", ...MODEL }),
    "PRECONDITION_FAILED",
  );
  t.is(e?.reason, "queue_full");
  t.is(e?.message, "You have 20 asks waiting to run.");
  // a post starts no run; another person's queue is their own
  ok(t, w.apply("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "x" }));
  const th = ask(t, w, "mona", open);
  t.is(
    refused(t, w.apply("mel", "research.forkNode", input(th, w.id())), "PRECONDITION_FAILED")
      ?.reason,
    "queue_full",
  );
  ok(t, w.apply("otto", "research.forkNode", input(th, w.id())));
  // a run that leaves the queue frees a place
  const one = w.all("run").find((r) => r.u === "mel" && r.status === "queued");
  if (one) finish(w, one.th, one.node);
  ok(t, w.apply("mel", "research.forkNode", input(th, w.id())));
});

test("G2: a look-up stores the prompt of its phrase, which the client never sends", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const look = { thread: th, parent: "r", kind: "lookup", ...MODEL };
  const id = w.id();
  ok(
    t,
    w.apply("mona", "research.forkNode", {
      ...look,
      id,
      look: "“tide gauge”,",
      quote: "Each tide gauge records the sea level.",
      b: 0,
    }),
  );
  t.like(w.get(`node:${id}`), {
    k: "lookup",
    look: "tide gauge",
    tpl: 1,
    q: LOOKUP_PROMPT_V1("tide gauge"),
    quote: "Each tide gauge records the sea level.",
    b: 0,
  });
  // the prompt as an extra field, five words, no quote, a phrase that starts
  // inside a word
  const quote = "Each tide gauge records the sea level.";
  refused(
    t,
    w.apply("mona", "research.forkNode", { ...look, id: w.id(), look: "tide", quote, q: "x" }),
    "BAD_REQUEST",
  );
  refused(
    t,
    w.apply("mona", "research.forkNode", {
      ...look,
      id: w.id(),
      look: "one two three four five",
      quote: "one two three four five",
    }),
    "BAD_REQUEST",
  );
  refused(
    t,
    w.apply("mona", "research.forkNode", { ...look, id: w.id(), look: "tide gauge" }),
    "BAD_REQUEST",
  );
  refused(
    t,
    w.apply("mona", "research.forkNode", {
      ...look,
      id: w.id(),
      look: "ide gauge",
      quote: "Each tide gauge records the sea level.",
    }),
    "BAD_REQUEST",
  );
});

test("G2: the client's prediction and the server's apply store the same prompt", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const i = {
    id: w.id(),
    thread: th,
    parent: "r",
    kind: "lookup",
    look: "sea level!",
    quote: "The sea level rose.",
    ...MODEL,
  };
  const { prediction, tx } = w.predict("mona", "research.forkNode", i);
  t.true("ok" in prediction && prediction.ok);
  ok(t, w.apply("mona", "research.forkNode", i));
  t.is(
    (tx.staged.get(`node:${i.id}`) as { q: string }).q,
    (w.get(`node:${i.id}`) as { q: string }).q,
  );
});

test("G6: a node with nothing of anyone else's under it is erased with its run; one with someone else's stays as a shell", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const lone = fork(t, w, "mona", th, "r", false);
  const run = w.all("run").find((r) => r.node === lone);
  if (run) w.put({ ...run, status: "running" });
  t.deepEqual(ok(t, w.apply("mona", "followups.delete", { thread: th, node: lone })), {
    kept: false,
  });
  t.is(w.get(`node:${lone}`), undefined);
  // its run record goes with it (M1b review 12): the run loop finds it gone
  t.is(w.get(`run:${run?.id ?? ""}`), undefined);
  t.like(w.get(`counts:${th}`), { r: 0 });
  // a node with only the author's own nodes and comments under it goes with
  // all of them, their answers and runs (M1b review 9)
  const top = fork(t, w, "mona", th);
  const child = fork(t, w, "mona", th, top);
  const grand = fork(t, w, "mona", th, child, false);
  const c = w.id();
  ok(t, w.apply("mona", "comments.create", { id: c, thread: th, node: child, t: "mine" }));
  t.like(w.get(`counts:${th}`), { r: 3 });
  t.deepEqual(ok(t, w.apply("mona", "followups.delete", { thread: th, node: top })), {
    kept: false,
  });
  for (const k of [
    `node:${top}`,
    `node:${child}`,
    `node:${grand}`,
    `answer:${top}`,
    `answer:${child}`,
    `comment:${c}`,
  ])
    t.is(w.get(k), undefined, k);
  t.false(w.all("run").some((r) => [top, child, grand].includes(r.node)));
  t.like(w.get(`counts:${th}`), { r: 0 });
  // a node with someone else's node under it, at any depth, stays as a
  // shell without text, and its own run is cancelled
  const kept = fork(t, w, "mona", th);
  const mid = fork(t, w, "mona", th, kept);
  fork(t, w, "otto", th, mid);
  t.deepEqual(ok(t, w.apply("mona", "followups.delete", { thread: th, node: kept })), {
    kept: true,
  });
  t.like(w.get(`node:${kept}`), { del: true, q: "" });
  t.truthy(w.get(`answer:${kept}`));
  t.truthy(w.get(`node:${mid}`));
  // and so does one with someone else's comment under it
  const commented = fork(t, w, "mona", th);
  ok(t, w.apply("otto", "comments.create", { id: w.id(), thread: th, node: commented, t: "x" }));
  t.deepEqual(ok(t, w.apply("mona", "followups.delete", { thread: th, node: commented })), {
    kept: true,
  });
  // only the author; never the root
  const n = fork(t, w, "mona", th);
  refused(t, w.apply("otto", "followups.delete", { thread: th, node: n }), "FORBIDDEN");
  refused(t, w.apply("mel", "followups.delete", { thread: th, node: "r" }), "BAD_REQUEST");
});

test("followups.update edits an ask's question, compares its rev, and never a look-up's prompt", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th);
  const rev = w.rev(`node:${n}`);
  refused(
    t,
    w.apply("otto", "followups.update", { thread: th, node: n, q: "x", base: { rev } }),
    "FORBIDDEN",
  );
  ok(
    t,
    w.apply("mona", "followups.update", { thread: th, node: n, q: " Better? ", base: { rev } }),
  );
  t.like(w.get(`node:${n}`), { q: "Better?" });
  refused(
    t,
    w.apply("mona", "followups.update", { thread: th, node: n, q: "x", base: { rev } }),
    "STALE",
  );
  const l = w.id();
  ok(
    t,
    w.apply("mona", "research.forkNode", {
      id: l,
      thread: th,
      parent: "r",
      kind: "lookup",
      look: "tide",
      quote: "The tide rose.",
      ...MODEL,
    }),
  );
  refused(
    t,
    w.apply("mona", "followups.update", {
      thread: th,
      node: l,
      q: "x",
      base: { rev: w.rev(`node:${l}`) },
    }),
    "BAD_REQUEST",
  );
});

test("E4: cancel stops a run that has not ended; run again queues a new attempt of a stopped run", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open, false);
  refused(t, w.apply("mona", "research.cancelNode", { thread: th, node: "r" }), "FORBIDDEN");
  refused(
    t,
    w.apply("mel", "research.retryNode", { thread: th, node: "r", ...MODEL, base: { attempt: 1 } }),
    "PRECONDITION_FAILED",
  );
  ok(t, w.apply("mel", "research.cancelNode", { thread: th, node: "r" }));
  const run = w.all("run").find((r) => r.th === th);
  t.like(run, { status: "cancelled", fail: { why: "stopped" } });
  t.like(w.get(`thread:${th}`), { running: false });
  // cancelling again changes nothing
  const rev = run?.rev;
  ok(t, w.apply("mel", "research.cancelNode", { thread: th, node: "r" }));
  t.is(w.rev(`run:${run?.id ?? ""}`), rev ?? 0);
  refused(
    t,
    w.apply("mel", "research.retryNode", {
      thread: th,
      node: "r",
      model: "gemini-flash",
      effort: "max",
      base: { attempt: 1 },
    }),
    "BAD_REQUEST",
  );
  ok(
    t,
    w.apply("mel", "research.retryNode", {
      thread: th,
      node: "r",
      model: "gemini-flash",
      effort: "low",
      base: { attempt: 1 },
    }),
  );
  t.like(w.get(`run:${run?.id ?? ""}`), {
    status: "queued",
    attempt: 2,
    fail: null,
    model: "gemini-flash",
    effort: "low",
  });
  t.like(w.get(`thread:${th}`), { running: true, model: "gemini-flash", effort: "low" });
  // a retry made before that one is STALE: the run was retried since
  refused(
    t,
    w.apply("mel", "research.retryNode", { thread: th, node: "r", ...MODEL, base: { attempt: 1 } }),
    "STALE",
  );
  // a complete run is not run again
  finish(w, th, "r");
  refused(
    t,
    w.apply("mel", "research.retryNode", { thread: th, node: "r", ...MODEL, base: { attempt: 2 } }),
    "PRECONDITION_FAILED",
  );
});
