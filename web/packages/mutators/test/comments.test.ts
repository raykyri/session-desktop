// Comments on an ask node (`01` C4; `03` G4).

import test from "ava";

import { ask, cast, fork, ok, post, refused } from "./world.js";

test("G4: a comment writes a comment record and never a run, and changes no count", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th);
  const runs = w.all("run").length;
  const counts = w.get(`counts:${th}`);
  const c = w.id();
  ok(t, w.apply("otto", "comments.create", { id: c, thread: th, node: n, t: "Nice." }));
  t.like(w.get(`comment:${c}`), { th, node: n, parent: null, u: "otto", t: "Nice." });
  t.is(w.all("run").length, runs);
  t.deepEqual(w.get(`counts:${th}`), counts);
  // nested one level, on the same node
  const sub = w.id();
  ok(t, w.apply("mel", "comments.create", { id: sub, thread: th, node: n, t: "x", parent: c }));
  refused(
    t,
    w.apply("mel", "comments.create", { id: w.id(), thread: th, node: "r", t: "x", parent: c }),
    "NOT_FOUND",
  );
  refused(
    t,
    w.apply("mel", "comments.create", { id: w.id(), thread: th, node: n, t: "x", parent: sub }),
    "NOT_FOUND",
  );
  const p = post(t, w, "mel", open);
  refused(
    t,
    w.apply("mel", "comments.create", { id: w.id(), thread: p, node: "r", t: "x" }),
    "BAD_REQUEST",
  );
});

test("an author's edit of a comment compares its rev; a delete keeps a top-level comment with comments as a shell", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const c = w.id();
  ok(t, w.apply("otto", "comments.create", { id: c, thread: th, node: "r", t: "x" }));
  const rev = w.rev(`comment:${c}`);
  refused(t, w.apply("mel", "comments.update", { id: c, t: "y", base: { rev } }), "FORBIDDEN");
  ok(t, w.apply("otto", "comments.update", { id: c, t: "y", base: { rev } }));
  refused(t, w.apply("otto", "comments.update", { id: c, t: "z", base: { rev } }), "STALE");
  const sub = w.id();
  ok(t, w.apply("mel", "comments.create", { id: sub, thread: th, node: "r", t: "s", parent: c }));
  t.deepEqual(ok(t, w.apply("otto", "comments.delete", { id: c })), { kept: true });
  t.like(w.get(`comment:${c}`), { t: "" });
  t.deepEqual(ok(t, w.apply("mel", "comments.delete", { id: sub })), { kept: false });
  t.is(w.get(`comment:${sub}`), undefined);
});
