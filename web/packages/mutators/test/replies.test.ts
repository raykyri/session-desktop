// Replies to a post (`01` C5, C15).

import test from "ava";

import { ask, cast, ok, post, refused } from "./world.js";

test("a reply counts for its post at every depth, and nests to any depth", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const top = w.id();
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: top, thread: p, t: "x" }));
  const sub = w.id();
  ok(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: sub, thread: p, t: "y", parent: top }),
  );
  // three levels deep
  const deep = w.id();
  ok(
    t,
    w.apply("otto", "research.createPostFollowUp", { id: deep, thread: p, t: "z", parent: sub }),
  );
  t.like(w.get(`reply:${deep}`), { parent: sub });
  // a parent of another post is not found
  const other = post(t, w, "mel", open);
  refused(
    t,
    w.apply("mona", "research.createPostFollowUp", {
      id: w.id(),
      thread: other,
      t: "z",
      parent: sub,
    }),
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
  t.like(w.get(`counts:${p}`), { r: 3 });
  t.like(w.get(`reply:${sub}`), { parent: top, u: "mona", t: "y" });
});

test("removing a middle reply erases everything under it and adjusts r; another's grandchild keeps a delete's shell", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const chain = (u: string[], parent?: string) => {
    const ids: string[] = [];
    let up = parent;
    for (const x of u) {
      const id = w.id();
      ok(
        t,
        w.apply(x, "research.createPostFollowUp", {
          id,
          thread: p,
          t: `by ${x}`,
          ...(up ? { parent: up } : {}),
        }),
      );
      ids.push(id);
      up = id;
    }
    return ids;
  };
  const [a, b, c, d] = chain(["otto", "mona", "otto", "mel"]);
  t.like(w.get(`counts:${p}`), { r: 4 });
  // the owner removes b: c and d go, b stays as a placeholder
  ok(t, w.apply("olga", "moderation.decide", { item: `r:${p}:${b}`, decision: "removed" }));
  t.like(w.get(`reply:${b}`), { mod: "removed", t: "" });
  t.is(w.get(`reply:${c}`), undefined);
  t.is(w.get(`reply:${d}`), undefined);
  t.like(w.get(`counts:${p}`), { r: 2 });
  // a removed reply at any depth takes no reply
  refused(
    t,
    w.apply("mona", "research.createPostFollowUp", { id: w.id(), thread: p, t: "x", parent: b }),
    "PRECONDITION_FAILED",
  );
  // otto's reply with otto's child and mona's grandchild: a shell
  const [e, f] = chain(["otto", "otto", "mona"]);
  t.deepEqual(ok(t, w.apply("otto", "replies.delete", { id: e ?? "" })), { kept: true });
  t.like(w.get(`reply:${e}`), { t: "", del: true });
  t.truthy(w.get(`reply:${f}`));
  // only otto's own under it, at any depth: all of it goes
  const [g, h, k] = chain(["otto", "otto", "otto"]);
  const r = (w.get(`counts:${p}`) as { r: number }).r;
  t.deepEqual(ok(t, w.apply("otto", "replies.delete", { id: g ?? "" })), { kept: false });
  for (const x of [g, h, k]) t.is(w.get(`reply:${x}`), undefined);
  t.like(w.get(`counts:${p}`), { r: r - 3 });
  void a;
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
