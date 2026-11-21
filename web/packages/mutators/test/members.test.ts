// Members (`01` C18; `04` B2): the owner removes, bans and unbans anyone but
// themselves; a removal compares the admission id (stale intent).

import test from "ava";

import { admission } from "./scenario.js";
import { admit, cast, ok, refused } from "./world.js";

test("a member's ban, removal and invite link are FORBIDDEN, and so is the owner's ban of themselves", (t) => {
  const { w, open, closed } = cast(t);
  refused(t, w.apply("mona", "members.ban", { space: open, user: "mel" }), "FORBIDDEN");
  refused(
    t,
    w.apply("ada", "members.remove", { space: closed, user: "olga", base: { adm: "x" } }),
    "FORBIDDEN",
  );
  refused(t, w.apply("ada", "invites.create", { id: w.id(), space: closed, days: 7 }), "FORBIDDEN");
  refused(t, w.apply("olga", "members.ban", { space: open, user: "olga" }), "FORBIDDEN");
  refused(
    t,
    w.apply("olga", "members.remove", { space: open, user: "olga", base: { adm: "x" } }),
    "FORBIDDEN",
  );
});

test("a ban removes the member, is logged once, and an unban is logged", (t) => {
  const { w, open } = cast(t);
  ok(t, w.apply("olga", "members.ban", { space: open, user: "mel" }));
  ok(t, w.apply("olga", "members.ban", { space: open, user: "mel" }));
  t.is(w.get(`member:${open}:mel`), undefined);
  t.like(w.get(`ban:${open}:mel`), { id: `${open}:mel`, u: "mel" });
  t.like(w.get(`space:${open}`), { members: 3 });
  ok(t, w.apply("olga", "members.unban", { space: open, user: "mel" }));
  t.is(w.get(`ban:${open}:mel`), undefined);
  t.deepEqual(
    w.all("modlog").map((m) => [m.act, m.author, m.by, m.item]),
    [
      ["ban", "mel", "olga", null],
      ["unban", "mel", "olga", null],
    ],
  );
});

test("a ban stops every write in its space, the author's own included", (t) => {
  const { w, open } = cast(t);
  const p = w.id();
  ok(t, w.apply("mel", "threads.create", { id: p, space: open, kind: "post", q: "x" }));
  ok(t, w.apply("olga", "members.ban", { space: open, user: "mel" }));
  const e = refused(t, w.apply("mel", "threads.delete", { id: p }), "FORBIDDEN");
  // the message names the channel
  t.is(e?.message, "You are banned from #lounge.");
  refused(t, w.apply("mel", "saved.set", { kind: "thread", id: p, on: true }), "FORBIDDEN");
});

test("a ban does not stop a person's own user-log writes: marking read, taking a save back (M1b review 11)", (t) => {
  const { w, open } = cast(t);
  const p = w.id();
  ok(t, w.apply("mel", "threads.create", { id: p, space: open, kind: "post", q: "hi" }));
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: true }));
  ok(t, w.apply("mona", "research.createPostFollowUp", { id: w.id(), thread: p, t: "@otto" }));
  const n = w.notifs("otto")[0];
  if (!n) return t.fail("otto was not notified");
  ok(t, w.apply("olga", "members.ban", { space: open, user: "otto" }));
  // an open space: a banned person still reads it, and their own records
  ok(t, w.apply("otto", "notifications.markRead", { id: n.id }));
  t.like(w.get(`notif:${n.id}`), { read: true });
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: false }));
  t.is(w.get(`save:otto:${p}`), undefined);
  // saving again is a write in the space: banned
  refused(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: true }), "FORBIDDEN");
});

test("a removal decided before the person was let in again is STALE", (t) => {
  const { w, closed } = cast(t);
  const adm = admission(w, closed, "ada");
  t.deepEqual(
    ok(t, w.apply("olga", "members.remove", { space: closed, user: "ada", base: { adm } })),
    { removed: true },
  );
  t.is(w.get(`member:${closed}:ada`), undefined);
  admit(t, w, closed, "ada");
  t.not(admission(w, closed, "ada"), adm);
  refused(
    t,
    w.apply("olga", "members.remove", { space: closed, user: "ada", base: { adm } }),
    "STALE",
  );
  // a person who is not a member: nothing to remove
  ok(t, w.apply("olga", "members.remove", { space: closed, user: "eve", base: { adm: "" } }));
});

test("a removal of a person who had already left answers removed: false and changes nothing (C12)", (t) => {
  const { w, closed } = cast(t);
  const adm = admission(w, closed, "ada");
  ok(t, w.apply("ada", "spaces.leave", { space: closed }));
  const before = w.get(`space:${closed}`);
  t.deepEqual(
    ok(t, w.apply("olga", "members.remove", { space: closed, user: "ada", base: { adm } })),
    { removed: false },
  );
  t.deepEqual(w.get(`space:${closed}`), before, "the member count is as it was");
  t.is(w.all("modlog").length, 0);
});
