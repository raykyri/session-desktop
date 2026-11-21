// The `pre`-stage limits of `04` Z1 on the server half: `setPreLimits` gives
// each mutator's `pre` a count per person; a write past it answers
// TOO_MANY_REQUESTS, records nothing and leaves the seq unused.

import type { PreLimit } from "@session/mutators";
import test from "ava";

import { actor, cast, ok, refused } from "./world.js";

test("a write past its pre-stage limit is refused, unrecorded, and the next write takes its seq", (t) => {
  const { w, open } = cast(t);
  const taken: [string, PreLimit][] = [];
  let left = 1;
  w.server.setPreLimits({
    take: (u, limit) => {
      taken.push([u, limit]);
      return left-- > 0;
    },
  });
  ok(t, w.as("eve", "spaces.join", { space: open }));
  ok(t, w.as("eve", "spaces.leave", { space: open }));
  const e = w.envelope("eve", "spaces.join", { space: open });
  refused(t, w.server.apply(actor("eve"), e), "TOO_MANY_REQUESTS");
  t.deepEqual(taken, [
    ["eve", "spaces.join"],
    ["eve", "spaces.join"],
  ]);
  t.is(w.get(`member:${open}:eve`), undefined);
  // not recorded: the same envelope applies once the limit allows it
  left = 1;
  ok(t, w.server.apply(actor("eve"), e));
  w.server.setPreLimits(null);
  ok(t, w.as("eve", "spaces.leave", { space: open }));
});
