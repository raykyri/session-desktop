// The `pre`-stage limits of `04` Z1 on the server half: `setPreLimits` gives
// each mutator's `pre` a count per person; a write past it answers
// TOO_MANY_REQUESTS with the counter's message, records nothing and leaves
// the seq unused. A use is taken only for a write that committed a change.

import type { PreLimit } from "@session/mutators";
import test from "ava";

import type { PreLimits } from "../src/server/index.js";

import { actor, cast, ok, refused } from "./world.js";

/** A counter with `left` uses for everyone, which records what it took. */
function counter(left: number) {
  const taken: [string, PreLimit][] = [];
  const checked: [string, PreLimit][] = [];
  const limits: PreLimits & { left: number } = {
    left,
    check(u, limit) {
      checked.push([u, limit]);
      return this.left > 0 ? true : `No ${limit} left.`;
    },
    take(u, limit) {
      taken.push([u, limit]);
      this.left -= 1;
    },
  };
  return { limits, taken, checked };
}

test("a write past its pre-stage limit is refused, unrecorded, and the next write takes its seq", (t) => {
  const { w, open } = cast(t);
  const { limits, taken } = counter(1);
  w.server.setPreLimits(limits);
  ok(t, w.as("eve", "spaces.join", { space: open }));
  ok(t, w.as("eve", "spaces.leave", { space: open }));
  const e = w.envelope("eve", "spaces.join", { space: open });
  const answer = w.server.apply(actor("eve"), e);
  refused(t, answer, "TOO_MANY_REQUESTS");
  t.like(answer, { error: { message: "No spaces.join left." } });
  t.deepEqual(taken, [["eve", "spaces.join"]]);
  t.is(w.get(`member:${open}:eve`), undefined);
  // not recorded: the same envelope applies once the limit allows it
  limits.left = 1;
  ok(t, w.server.apply(actor("eve"), e));
  w.server.setPreLimits(null);
  ok(t, w.as("eve", "spaces.leave", { space: open }));
});

test("a refused write and a write that changes nothing take no use of the limit", (t) => {
  const { w, open } = cast(t);
  const { limits, taken, checked } = counter(1);
  w.server.setPreLimits(limits);
  // refused after `pre` (recorded): a channel name that is taken
  for (let k = 0; k < 5; k++)
    refused(t, w.as("eve", "spaces.create", { id: w.id(), name: "lounge" }), "CONFLICT");
  // applied, changing nothing: mel is a member already
  for (let k = 0; k < 5; k++) ok(t, w.as("mel", "spaces.join", { space: open }));
  t.is(checked.length, 10);
  t.deepEqual(taken, []);
  // the one use is still there
  ok(t, w.as("eve", "spaces.create", { id: w.id(), name: "eves" }));
  t.deepEqual(taken, [["eve", "spaces.create"]]);
  refused(t, w.as("eve", "spaces.create", { id: w.id(), name: "eves-2" }), "TOO_MANY_REQUESTS");
  w.server.setPreLimits(null);
});
