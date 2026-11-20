// `04` B6: a space whose owner's account was deleted is frozen: readable, and
// closed to every write but deleting one's own items, leaving, and the
// person's own saves and notifications.

import test from "ava";

import { frozenMessage } from "../src/index.js";

import { ask, cast, fork, ok, post, refused } from "./world.js";

test("a frozen space refuses every write but deleting one's own items and leaving", (t) => {
  const { w, open, closed } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th);
  const p = post(t, w, "mel", open);
  const rep = w.id();
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: rep, thread: p, t: "x" }));
  const c = w.id();
  ok(t, w.apply("otto", "comments.create", { id: c, thread: th, node: n, t: "x" }));
  const link = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
    code: string;
  };
  // the operator job that deletes olga's account
  for (const sp of [open, closed]) {
    const s = w.get(`space:${sp}`);
    if (s?.kind === "space") w.put({ ...s, frozen: true });
  }
  const e = refused(
    t,
    w.apply("mona", "threads.create", { id: w.id(), space: open, kind: "post", q: "x" }),
    "FORBIDDEN",
  );
  t.is(e?.message, frozenMessage("lounge"));
  refused(t, w.apply("eve", "spaces.join", { space: open }), "FORBIDDEN");
  refused(t, w.apply("eve", "spaces.join", { space: closed, invite: link.code }), "FORBIDDEN");
  refused(
    t,
    w.apply("otto", "research.forkNode", {
      id: w.id(),
      thread: th,
      parent: n,
      kind: "ask",
      q: "x",
      model: "claude-fable",
      effort: "low",
    }),
    "FORBIDDEN",
  );
  refused(
    t,
    w.apply("otto", "comments.create", { id: w.id(), thread: th, node: n, t: "x" }),
    "FORBIDDEN",
  );
  refused(
    t,
    w.apply("mel", "threads.update", { id: p, q: "y", base: { rev: w.rev(`thread:${p}`) } }),
    "FORBIDDEN",
  );
  refused(t, w.apply("olga", "spaces.update", { id: open, desc: "x" }), "FORBIDDEN");
  refused(t, w.apply("olga", "members.ban", { space: open, user: "otto" }), "FORBIDDEN");
  // deleting one's own items, saves, notifications and leaving still work
  ok(t, w.apply("otto", "comments.delete", { id: c }));
  ok(t, w.apply("otto", "replies.delete", { id: rep }));
  ok(t, w.apply("mona", "followups.delete", { thread: th, node: n }));
  ok(t, w.apply("mel", "threads.delete", { id: p }));
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: th, on: true }));
  const note = w.notifs("mel")[0];
  if (note) ok(t, w.apply("mel", "notifications.markRead", { id: note.id }));
  ok(t, w.apply("otto", "spaces.leave", { space: open }));
});
