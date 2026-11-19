// The write and read rules review round 2 of phase 1 (reviewer A) found
// broken, as they stand after their fixes, at the package level
// (`r2a/e02-rules.ts`). The server's tests cover the same rules over both
// stores (`web/packages/sync/test/server-r2.test.ts`).

import test from "ava";

import { view, type MemoryStore, type StoredRecord } from "../src/index.js";

import type { World } from "./world.js";
import { cast, ok, refused } from "./world.js";

const asReader = (s: MemoryStore) => ({
  get: (kind: string, id: string) => s.records.get(`${kind}:${id}`),
});
const seen = (w: World, key: string, u: string | null) => {
  const r = w.get(key);
  return r ? (view(asReader(w.store) as never, r, u) as unknown as Record<string, unknown>) : null;
};
const rec = (w: World, key: string) => w.get(key) as unknown as Record<string, unknown>;
const runOf = (w: World, th: string, node: string) =>
  [...w.store.records.values()].find(
    (r: StoredRecord) => r.kind === "run" && r.th === th && r.node === node,
  ) as unknown as { id: string } | undefined;

// ---- H2: model and skill

test("H2: a model is a model id and a skill a skill of the space", (t) => {
  const { w, open, closed } = cast(t);
  const create = (x: object) =>
    w.run("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "q", ...x });
  for (const model of ["ABUSE-MODEL", "two words", ""])
    refused(t, create({ model }), "BAD_REQUEST");
  const other = w.id();
  ok(t, w.run("olga", "skills.create", { id: other, space: closed, name: "S", prompt: "p" }));
  for (const skill of [w.id(), other, "ABUSE SKILL"]) refused(t, create({ skill }), "NOT_FOUND");
  const sk = w.id();
  ok(t, w.run("mona", "skills.create", { id: sk, space: open, name: "S", prompt: "p" }));
  ok(t, create({ model: "gpt6m", skill: sk }));
});

test("H2: hiding an ask redacts its model and skill and its runs' model; removing and deleting erase them", (t) => {
  const { w, open } = cast(t);
  const sk = w.id();
  ok(t, w.run("mona", "skills.create", { id: sk, space: open, name: "S", prompt: "p" }));
  const th = w.id();
  ok(
    t,
    w.run("mel", "threads.create", {
      id: th,
      space: open,
      kind: "ask",
      q: "q",
      model: "abuse-model",
      skill: sk,
    }),
  );
  const fu = w.id();
  ok(
    t,
    w.run("otto", "research.forkNode", {
      id: fu,
      thread: th,
      parent: "r",
      q: "f",
      model: "abuse-fmodel",
    }),
  );
  const run = runOf(w, th, "r")?.id ?? "";
  const frun = runOf(w, th, fu)?.id ?? "";
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  ok(t, w.run("mona", "moderation.decide", { item: `f:${th}:${fu}`, decision: "hidden" }));
  t.like(seen(w, `thread:${th}`, null) ?? {}, { model: null, skill: null });
  t.like(seen(w, `followup:${fu}`, "eve") ?? {}, { model: null });
  t.like(seen(w, `run:${run}`, null) ?? {}, { model: null });
  t.like(seen(w, `run:${frun}`, "mel") ?? {}, { model: null }, "the thread's author: not theirs");
  t.like(seen(w, `run:${run}`, "mel") ?? {}, { model: "abuse-model" });
  t.like(seen(w, `run:${frun}`, "mona") ?? {}, { model: "abuse-fmodel" });
  ok(t, w.run("mona", "moderation.decide", { item: `f:${th}:${fu}`, decision: "removed" }));
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.like(rec(w, `thread:${th}`), { model: null, skill: null });
  t.false(JSON.stringify([...w.store.records.values()]).includes("abuse-"));
  const gone = w.id();
  ok(
    t,
    w.run("mel", "threads.create", {
      id: gone,
      space: open,
      kind: "ask",
      q: "q",
      model: "gone-model",
      skill: sk,
    }),
  );
  ok(t, w.run("mel", "threads.delete", { id: gone }));
  t.like(rec(w, `thread:${gone}`), { model: null, skill: null });
});

// ---- W1: a run again counts as an edit while hidden

test("W1: a run again of a hidden ask or follow-up counts as an edit of its hide record", (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.run("mel", "threads.create", { id: th, space: open, kind: "ask", q: "same" }));
  const fu = w.id();
  ok(t, w.run("mel", "followups.ask", { id: fu, thread: th, q: "f" }));
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  ok(t, w.run("mona", "moderation.decide", { item: `f:${th}:${fu}`, decision: "hidden" }));
  const ed = (key: string) => rec(w, key)["ed"];
  ok(
    t,
    w.run("mel", "threads.update", {
      id: th,
      q: "same",
      run: true,
      base: { rev: w.rev(`thread:${th}`) },
    }),
  );
  t.is(ed(`hide:thread:${th}`), 1);
  ok(
    t,
    w.run("mel", "followups.update", {
      thread: th,
      node: fu,
      q: "f",
      run: true,
      base: { rev: w.rev(`followup:${fu}`) },
    }),
  );
  t.is(ed(`hide:followup:${fu}`), 1);
});

// ---- W2: an access end is its person's

test("W2: a run's access end reads as interrupted to everyone but its person", (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.run("mel", "threads.create", { id: th, space: open, kind: "ask", q: "q" }));
  const run = runOf(w, th, "r") as unknown as StoredRecord & { id: string };
  w.store.records.set(`run:${run.id}`, { ...run, status: "failed", end: "access" } as StoredRecord);
  t.like(seen(w, `run:${run.id}`, "mel") ?? {}, { end: "access" });
  for (const u of [null, "otto", "mona"])
    t.like(seen(w, `run:${run.id}`, u) ?? {}, { end: "interrupted" }, String(u));
});
