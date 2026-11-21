// The rev rule lives in `StagedTx` (M1b review 2), so a client's prediction
// and the server's apply stage the same rev: a write that leaves a record as
// it is committed writes nothing, any other write stages the committed rev +
// 1, once per commit, and a record written again at a deleted key continues
// from the registry's last rev.

import test from "ava";

import { StagedTx, msToIso } from "../src/index.js";

import { cast, ok, post } from "./world.js";

test("a prediction stages the rev the server commits", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const before = w.rev(`thread:${p}`);
  const input = { id: p, q: "Edited", base: { rev: before } };
  const { prediction, tx } = w.predict("mel", "threads.update", input);
  t.true("ok" in prediction && prediction.ok);
  const staged = tx.staged.get(`thread:${p}`);
  ok(t, w.apply("mel", "threads.update", input));
  t.is(staged?.rev, before + 1);
  t.is(w.rev(`thread:${p}`), before + 1);
});

test("a write that changes nothing stages nothing; two writes of a key bump its rev once", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const rec = w.get(`thread:${p}`);
  if (rec?.kind !== "thread") return t.fail();
  const tx = new StagedTx(w.store, "mel", msToIso(w.ms), w.id(), "server");
  tx.put({ ...rec });
  t.is(tx.staged.size, 0);
  tx.put({ ...rec, q: "a" });
  tx.put({ ...rec, q: "b" });
  t.is(tx.staged.get(`thread:${p}`)?.rev, rec.rev + 1);
  // back to the committed record: nothing is written
  tx.put({ ...rec });
  t.false(tx.staged.has(`thread:${p}`));
});

test("a record written again at a deleted key continues from its last rev", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: true }));
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: false }));
  t.is(w.get(`save:otto:${p}`), undefined);
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: true }));
  t.is(w.rev(`save:otto:${p}`), 2);
});
