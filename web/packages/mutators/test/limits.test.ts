// The limits of `04` Z1 that the mutators apply: the `pre`-stage limits per
// person (channels made, channel invite links made, joins), which refuse
// with TOO_MANY_REQUESTS once used up, and the 50 open links a channel may
// have, a recorded PRECONDITION_FAILED.

import test from "ava";

import { OPEN_LINKS_MAX } from "../src/index.js";

import { DAY, World, cast, ok, refused } from "./world.js";

test("a pre-stage limit refuses the write after its last use, and the refusal writes nothing", (t) => {
  const w = new World();
  w.limits = { "spaces.create": 2 };
  ok(t, w.apply("olga", "spaces.create", { id: w.id(), name: "one" }));
  ok(t, w.apply("olga", "spaces.create", { id: w.id(), name: "two" }));
  const before = w.all("space").length;
  refused(t, w.apply("olga", "spaces.create", { id: w.id(), name: "three" }), "TOO_MANY_REQUESTS");
  t.is(w.all("space").length, before);
  // per person: another person still has their uses
  ok(t, w.apply("mona", "spaces.create", { id: w.id(), name: "four" }));
});

test("joins and channel invite links count in their own limits", (t) => {
  const { w, open, closed } = cast(t);
  w.limits = { "spaces.join": 1, "invites.create": 1 };
  ok(t, w.apply("eve", "spaces.join", { space: open }));
  ok(t, w.apply("eve", "spaces.leave", { space: open }));
  refused(t, w.apply("eve", "spaces.join", { space: open }), "TOO_MANY_REQUESTS");
  ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 }));
  refused(
    t,
    w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 }),
    "TOO_MANY_REQUESTS",
  );
});

test("a write the permission checks refuse uses none of the limit", (t) => {
  const { w, closed } = cast(t);
  w.limits = { "spaces.join": 1 };
  refused(t, w.apply("eve", "spaces.join", { space: closed }), "FORBIDDEN");
  const link = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
    code: string;
  };
  ok(t, w.apply("eve", "spaces.join", { space: closed, invite: link.code }));
});

test("a channel has at most 50 open invite links; used, revoked and expired ones do not count", (t) => {
  const { w, closed } = cast(t);
  const ids: string[] = [];
  for (let k = 0; k < OPEN_LINKS_MAX; k++) {
    const id = w.id();
    ids.push(id);
    ok(t, w.apply("olga", "invites.create", { id, space: closed, days: 1 }));
  }
  const e = refused(
    t,
    w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 }),
    "PRECONDITION_FAILED",
  );
  t.is(e?.message, "This channel has 50 open invite links. Revoke one to make another.");
  ok(t, w.apply("olga", "invites.revoke", { id: ids[0] }));
  ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 }));
  refused(
    t,
    w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 }),
    "PRECONDITION_FAILED",
  );
  // the one-day links expire
  w.ms += DAY + 1000;
  ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 }));
});
