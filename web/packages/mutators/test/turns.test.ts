// Committed turns of a run (`03` §1, T1): written by the server's run loop,
// read like the ask they belong to, erased with it.

import test from "ava";

import { msToIso, turnKey, view, type TurnRec } from "../src/index.js";

import { ask, cast, fork, ok, type World } from "./world.js";

/** What the run loop commits at a step finish: one turn of the node's run. */
function turn(w: World, thread: string, node: string, text: string): string {
  const run = w.all("run").find((r) => r.th === thread && r.node === node);
  if (!run) throw new Error(`no run of ${node}`);
  const n = w.all("turn").filter((x) => x.run === run.id && x.attempt === run.attempt).length;
  w.put({
    kind: "turn",
    run: run.id,
    attempt: run.attempt,
    n,
    th: thread,
    s: run.s,
    role: "assistant",
    blocks: [{ type: "text", text }],
    createdAt: msToIso(w.ms),
  });
  return turnKey(run.id, run.attempt, n);
}

const blocks = (w: World, key: string, u: string | null) =>
  (view(w.store, w.get(key) as TurnRec, u) as TurnRec | null)?.blocks;

test("a turn is read like its ask: a hidden ask's turns are blank but for its author and the owner", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th, "r", false);
  const key = turn(w, th, n, "Partial text.");
  t.deepEqual(blocks(w, key, "otto"), [{ type: "text", text: "Partial text." }]);
  t.deepEqual(blocks(w, key, null), [{ type: "text", text: "Partial text." }]);
  const before = w.rev(key);
  ok(t, w.apply("olga", "moderation.decide", { item: `f:${th}:${n}`, decision: "hidden" }));
  // the turn is written again, so every reader is served it as they may read it now
  t.is(w.rev(key), before + 1);
  t.deepEqual(blocks(w, key, "otto"), []);
  t.deepEqual(blocks(w, key, null), []);
  t.deepEqual(blocks(w, key, "mona"), [{ type: "text", text: "Partial text." }]);
  t.deepEqual(blocks(w, key, "olga"), [{ type: "text", text: "Partial text." }]);
  const node = w.get(`node:${n}`);
  ok(
    t,
    w.apply("olga", "moderation.decide", {
      item: `f:${th}:${n}`,
      decision: "shown",
      base: { rev: node?.rev ?? 0 },
    }),
  );
  t.is(w.rev(key), before + 2);
  t.deepEqual(blocks(w, key, "otto"), [{ type: "text", text: "Partial text." }]);
});

test("a private channel's turns are for its members", (t) => {
  const { w, closed } = cast(t);
  const th = ask(t, w, "ada", closed, false);
  const key = turn(w, th, "r", "Root text.");
  t.truthy(blocks(w, key, "ada"));
  t.is(blocks(w, key, "eve"), undefined);
  t.is(blocks(w, key, null), undefined);
});

test("removing a thread or a node erases its turns; deleting them takes their turns", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open, false);
  const root = turn(w, th, "r", "Root.");
  ok(t, w.apply("olga", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.is(w.get(root), undefined);

  const th2 = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th2, "r", false);
  const nodeTurn = turn(w, th2, n, "Node.");
  ok(t, w.apply("olga", "moderation.decide", { item: `f:${th2}:${n}`, decision: "removed" }));
  t.is(w.get(nodeTurn), undefined);

  const th3 = ask(t, w, "mel", open);
  const m = fork(t, w, "mona", th3, "r", false);
  const mine = turn(w, th3, m, "Mine.");
  ok(t, w.apply("mona", "followups.delete", { thread: th3, node: m }));
  t.is(w.get(mine), undefined);

  const th4 = ask(t, w, "mel", open, false);
  const rootTurn = turn(w, th4, "r", "Root.");
  ok(t, w.apply("mel", "threads.delete", { id: th4 }));
  t.is(w.get(rootTurn), undefined);
});
