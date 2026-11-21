// Replies to a post (`01` C5, C15).

import test from "ava";

import { ask, cast, ok, post, refused } from "./world.js";

test("a reply counts for its post at every depth, under a top-level reply only", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const top = w.id();
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: top, thread: p, t: "x" }));
  const sub = w.id();
  ok(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: sub, thread: p, t: "y", parent: top }),
  );
  refused(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: w.id(), thread: p, t: "z", parent: sub }),
    "NOT_FOUND",
  );
  refused(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: w.id(), thread: p, t: "  " }),
    "BAD_REQUEST",
  );
  const a = ask(t, w, "mel", open);
  refused(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: w.id(), thread: a, t: "z" }),
    "BAD_REQUEST",
  );
  t.like(w.get(`counts:${p}`), { r: 2 });
  t.like(w.get(`reply:${sub}`), { parent: top, u: "mona", t: "y" });
});

test("an author's edit of a reply compares its rev; a delete keeps a top-level reply with replies as a shell", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const top = w.id();
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: top, thread: p, t: "x" }));
  const rev = w.rev(`reply:${top}`);
  refused(t, w.apply("mona", "replies.update", { id: top, t: "y", base: { rev } }), "FORBIDDEN");
  ok(t, w.apply("otto", "replies.update", { id: top, t: " y ", base: { rev } }));
  t.like(w.get(`reply:${top}`), { t: "y", edited: true, del: false });
  refused(t, w.apply("otto", "replies.update", { id: top, t: "z", base: { rev } }), "STALE");
  const sub = w.id();
  ok(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: sub, thread: p, t: "s", parent: top }),
  );
  t.deepEqual(ok(t, w.apply("otto", "replies.delete", { id: top })), { kept: true });
  t.like(w.get(`reply:${top}`), { t: "", del: true });
  refused(
    t,
    w.apply("otto", "replies.update", { id: top, t: "back", base: { rev: w.rev(`reply:${top}`) } }),
    "PRECONDITION_FAILED",
  );
  t.deepEqual(ok(t, w.apply("mona", "replies.delete", { id: sub })), { kept: false });
  t.is(w.get(`reply:${sub}`), undefined);
  t.like(w.get(`counts:${p}`), { r: 1 });
  refused(t, w.apply("mona", "replies.delete", { id: top }), "FORBIDDEN");
});

test("a top-level reply with only its author's replies under it goes with them (M1b review 9)", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const top = w.id();
  const sub = w.id();
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: top, thread: p, t: "x" }));
  ok(
    t,
    w.apply("otto", "research.createPostFollowUp", { id: sub, thread: p, t: "y", parent: top }),
  );
  t.like(w.get(`counts:${p}`), { r: 2 });
  t.deepEqual(ok(t, w.apply("otto", "replies.delete", { id: top })), { kept: false });
  t.is(w.get(`reply:${top}`), undefined);
  t.is(w.get(`reply:${sub}`), undefined);
  t.like(w.get(`counts:${p}`), { r: 0 });
});
