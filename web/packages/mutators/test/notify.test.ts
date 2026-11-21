// Coalesced notifications (`01` C16): `reply`, `branch` and `comment`
// coalesce into one unread notification per (recipient, type, thread),
// stamped with the latest write's time; once the recipient read it, the
// next write starts a new one.

import test from "ava";

import { msToIso } from "../src/index.js";

import { MINUTE, cast, ok, post } from "./world.js";

test("a reply after the recipient read the coalesced notification starts a new unread one with n: 1", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mona", open);
  ok(t, w.apply("mel", "research.createPostFollowUp", { id: w.id(), thread: p, t: "One" }));
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: w.id(), thread: p, t: "Two" }));
  const [first] = w.notifs("mona");
  t.like(first, { type: "reply", n: 2, read: false });
  if (!first) return;
  ok(t, w.apply("mona", "notifications.markRead", { id: first.id }));
  ok(t, w.apply("mel", "research.createPostFollowUp", { id: w.id(), thread: p, t: "Three" }));
  const now = w.notifs("mona");
  t.is(now.length, 2);
  t.like(w.get(`notif:${first.id}`), { n: 2, read: true });
  t.like(
    now.find((n) => n.id !== first.id),
    { type: "reply", n: 1, read: false, actor: "mel" },
  );
});

test("a coalesced notification carries the time of the latest write", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mona", open);
  ok(t, w.apply("mel", "research.createPostFollowUp", { id: w.id(), thread: p, t: "One" }));
  const at = msToIso(w.ms);
  w.advance(5 * MINUTE);
  ok(t, w.apply("otto", "research.createPostFollowUp", { id: w.id(), thread: p, t: "Two" }));
  const notes = w.notifs("mona");
  t.is(notes.length, 1);
  t.like(notes[0], { n: 2, actor: "otto", createdAt: msToIso(w.ms) });
  t.not(notes[0]?.createdAt, at);
});
