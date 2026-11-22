// Spaces (`01` C9, C11, C14, C18; `04` B1-B3).

import test from "ava";

import { INVITE_LINK_DEAD } from "../src/index.js";

import { DAY, World, admit, cast, ok, refused } from "./world.js";

test("names are unique across all spaces, and the CONFLICT names only the name sent", (t) => {
  const { w } = cast(t);
  const e = refused(t, w.apply("eve", "spaces.create", { id: w.id(), name: "#LAB" }), "CONFLICT");
  t.is(e?.message, "#lab already exists.");
  refused(t, w.apply("eve", "spaces.create", { id: "sp-1", name: "new" }), "BAD_REQUEST");
});

test("the creator is the owner and only member", (t) => {
  const w = new World();
  const id = w.id();
  t.deepEqual(ok(t, w.apply("eve", "spaces.create", { id, name: "eves", desc: " Hi " })), { id });
  const s = w.get(`space:${id}`);
  t.like(s, { owner: "eve", members: 1, desc: "Hi", vis: "open", frozen: false });
  t.like(w.get(`member:${id}:eve`), { role: "owner" });
  t.like(w.get(`stats:${id}`), { posts: 0 });
});

test("only the owner edits About, at most 300 characters", (t) => {
  const { w, open } = cast(t);
  refused(t, w.apply("mona", "spaces.update", { id: open, desc: "Mine" }), "FORBIDDEN");
  refused(t, w.apply("olga", "spaces.update", { id: open, desc: "x".repeat(301) }), "BAD_REQUEST");
  ok(t, w.apply("olga", "spaces.update", { id: open, desc: "  Be kind.  " }));
  t.like(w.get(`space:${open}`), { desc: "Be kind.", name: "lounge" });
  refused(t, w.apply("olga", "spaces.update", { id: open, name: "x", desc: "" }), "BAD_REQUEST");
});

test("a private space admits through a link, once, until it expires", (t) => {
  const { w, closed } = cast(t);
  refused(t, w.apply("eve", "spaces.join", { space: closed }), "FORBIDDEN");
  const r = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
    code: string;
  };
  refused(t, w.apply("eve", "spaces.join", { space: closed, invite: "nope" }), "FORBIDDEN");
  ok(t, w.apply("eve", "spaces.join", { space: closed, invite: r.code }));
  t.like(w.get(`space:${closed}`), { members: 3 });
  // used up
  refused(t, w.apply("mel", "spaces.join", { space: closed, invite: r.code }), "FORBIDDEN");
  // expired, checked at apply time
  const late = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 1 })) as {
    code: string;
  };
  w.advance(DAY + 1000);
  const e = refused(
    t,
    w.apply("mel", "spaces.join", { space: closed, invite: late.code }),
    "FORBIDDEN",
  );
  t.is(e?.message, INVITE_LINK_DEAD);
});

test("a link stops admitting at its expiry time exactly", (t) => {
  const { w, closed } = cast(t);
  const r = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 1 })) as {
    code: string;
  };
  w.advance(DAY);
  refused(t, w.apply("eve", "spaces.join", { space: closed, invite: r.code }), "FORBIDDEN");
  t.is(w.get(`member:${closed}:eve`), undefined);
});

test("a banned person cannot join, with or without a link", (t) => {
  const { w, open, closed } = cast(t);
  ok(t, w.apply("olga", "members.ban", { space: open, user: "eve" }));
  refused(t, w.apply("eve", "spaces.join", { space: open }), "FORBIDDEN");
  ok(t, w.apply("olga", "members.ban", { space: closed, user: "eve" }));
  const r = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
    code: string;
  };
  refused(t, w.apply("eve", "spaces.join", { space: closed, invite: r.code }), "FORBIDDEN");
});

test("the owner cannot leave; a member can, and the count follows", (t) => {
  const { w, open, closed } = cast(t);
  refused(t, w.apply("olga", "spaces.leave", { space: open }), "PRECONDITION_FAILED");
  ok(t, w.apply("mona", "spaces.leave", { space: open }));
  t.is(w.get(`member:${open}:mona`), undefined);
  t.like(w.get(`space:${open}`), { members: 3 });
  // joining an open space again gives a new admission id
  const before = w.all("member").length;
  ok(t, w.apply("mona", "spaces.join", { space: open }));
  t.is(w.all("member").length, before + 1);
  admit(t, w, closed, "mel");
  t.like(w.get(`space:${closed}`), { members: 3 });
});
