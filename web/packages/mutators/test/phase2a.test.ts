// Phase 2a: run turns are records (`turn`, report-1b finding 6) and an API
// key's record carries its cap.
//
// A turn is text of its run's node: it is read by the run's readers, its
// `body` is blanked wherever the node's text is redacted, and it is deleted
// with its run (a removal, a thread's or a follow-up's delete, a space's
// erasure).

import test from "ava";

import {
  keyOf,
  logsOf,
  view,
  viewDependents,
  type Reader,
  type RunRec,
  type StoredRecord,
  type TurnRec,
} from "../src/index.js";

import { cast, ok, thread, type World } from "./world.js";

const reader = (w: World): Reader => ({
  get: (kind, id) => w.get(`${kind}:${id}`) as never,
});

const runsOf = (w: World, th: string) =>
  [...w.store.records.values()].filter((r): r is RunRec => r.kind === "run" && r.th === th);

/** A turn of `run`, as the server writes one. */
function addTurn(w: World, run: RunRec, n: number, body: unknown): TurnRec {
  const t: TurnRec = {
    kind: "turn",
    run: run.id,
    th: run.th,
    s: run.s,
    u: run.u,
    node: run.node,
    attempt: run.attempt,
    n,
    body,
    createdAt: "2026-11-16T10:00:00Z",
    rev: 1,
  };
  w.store.commit([[keyOf(t), t]]);
  return t;
}

const turnsAtRest = (w: World) =>
  [...w.store.records.values()].filter((r): r is TurnRec => r.kind === "turn");

test("a turn is keyed by its run and number, in its space's log, read as its run is", (t) => {
  const { w, open, closed } = cast(t);
  const th = thread(t, w, "mel", open);
  const [run] = runsOf(w, th);
  if (!run) return t.fail("no run");
  const turn = addTurn(w, run, 1, { text: "TURN-TEXT" });
  t.is(keyOf(turn), `turn:${run.id}:1`);
  t.deepEqual(logsOf(turn), [`space:${open}`]);
  t.deepEqual(view(reader(w), turn, null), turn);
  // in a closed space, its members only
  const ct = thread(t, w, "mel", closed);
  const [cr] = runsOf(w, ct);
  if (!cr) return t.fail("no run");
  const cturn = addTurn(w, cr, 1, "CLOSED-TURN");
  t.is(view(reader(w), cturn, null), null);
  t.is(view(reader(w), cturn, "otto"), null);
  t.deepEqual(view(reader(w), cturn, "mona"), cturn);
});

test("a turn's body is blanked with its node: a hidden ask or follow-up, for everyone but its author and the moderators", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const fu = w.id();
  ok(t, w.run("otto", "followups.ask", { id: fu, thread: th, q: "And then?" }));
  const runs = runsOf(w, th);
  const ask = runs.find((r) => r.node === "r");
  const fur = runs.find((r) => r.node === fu);
  if (!ask || !fur) return t.fail("no runs");
  const a = addTurn(w, ask, 1, "ASK-TURN");
  const f = addTurn(w, fur, 1, "FU-TURN");
  // hiding the ask blanks the ask's turns, not the follow-up's
  const hide = w.run("mona", "moderation.decide", {
    item: `a:${th}`,
    decision: "hidden",
    base: { rev: 0 },
  });
  ok(t, hide);
  const g = reader(w);
  for (const u of [null, "otto", "eve"]) {
    t.is((view(g, a, u) as TurnRec).body, null, String(u));
    t.is((view(g, f, u) as TurnRec).body, "FU-TURN", String(u));
  }
  for (const u of ["mel", "mona"]) t.is((view(g, a, u) as TurnRec).body, "ASK-TURN", u);
  // the hide record's change rewrites the turns' views too
  const h = w.get(`hide:thread:${th}`) as StoredRecord;
  const deps = viewDependents(h, {
    get: (k) => w.get(k),
    runsOf: (x) => runsOf(w, x),
    turnsOf: (run) => turnsAtRest(w).filter((x) => x.run === run),
  });
  t.true(deps.includes(`turn:${ask.id}:1`));
  t.false(deps.includes(`turn:${fur.id}:1`));
  // a hidden follow-up: its turns, for its author otto and the moderators
  ok(
    t,
    w.run("mona", "moderation.decide", {
      item: `f:${th}:${fu}`,
      decision: "hidden",
      base: { rev: 0 },
    }),
  );
  t.is((view(reader(w), f, "mel") as TurnRec).body, null);
  t.is((view(reader(w), f, "otto") as TurnRec).body, "FU-TURN");
});

test("a removal erases the turns of the item's runs, and of everything under it", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const fu = w.id();
  ok(t, w.run("otto", "followups.ask", { id: fu, thread: th, q: "And then?" }));
  for (const r of runsOf(w, th)) addTurn(w, r, 1, `TURN-${r.node}`);
  t.is(turnsAtRest(w).length, 2);
  // the follow-up alone: its turns go, the ask's stay
  ok(
    t,
    w.run("mona", "moderation.decide", {
      item: `f:${th}:${fu}`,
      decision: "removed",
      base: { rev: 0 },
    }),
  );
  t.deepEqual(
    turnsAtRest(w).map((x) => x.body),
    ["TURN-r"],
  );
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.deepEqual(turnsAtRest(w), []);
});

test("deleting a thread or a follow-up deletes its runs' turns", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const fu = w.id();
  ok(t, w.run("mel", "followups.ask", { id: fu, thread: th, q: "And then?" }));
  for (const r of runsOf(w, th)) addTurn(w, r, 1, `TURN-${r.node}`);
  ok(t, w.run("mel", "followups.delete", { thread: th, node: fu }));
  t.deepEqual(
    turnsAtRest(w).map((x) => x.node),
    ["r"],
  );
  ok(t, w.run("mel", "threads.delete", { id: th }));
  t.deepEqual(turnsAtRest(w), []);
});
