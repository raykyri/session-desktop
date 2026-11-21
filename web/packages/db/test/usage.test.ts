// Recorded usage rows and the per-member weekly allowance override
// (`user_limits.weekly_tokens`, plan `03` K3).

import test from "ava";

import { usage } from "../src/index.js";
import { usageEvents } from "../src/schema/usage.js";

import { createFixture } from "./helpers.js";

test("a usage row is recorded with its counts and time", (t) => {
  const fixture = createFixture(t);
  const id = usage.record(fixture.db, fixture.userId, {
    kind: "search",
    provider: "parallel",
    inputTokens: 3,
    at: 1_700_000_000_000,
  });
  const rows = fixture.db.select().from(usageEvents).all();
  t.is(rows.length, 1);
  t.like(rows[0], {
    id,
    userId: fixture.userId,
    kind: "search",
    provider: "parallel",
    inputTokens: 3,
    outputTokens: 0,
    createdAt: 1_700_000_000_000,
  });
});

test("K3: a member has no weekly allowance override until one is set; null clears it", (t) => {
  const fixture = createFixture(t);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId), null);
  usage.setWeeklyAllowance(fixture.db, fixture.userId, 5_000_000);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId), 5_000_000);
  usage.setWeeklyAllowance(fixture.db, fixture.userId, 3_000_000);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId), 3_000_000);
  usage.setWeeklyAllowance(fixture.db, fixture.userId, null);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId), null);
  t.is(usage.weeklyAllowance(fixture.db, "someone-else"), null);
});

test("K3: a weekly allowance override is a positive whole number of tokens", (t) => {
  const fixture = createFixture(t);
  for (const tokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    t.throws(() => usage.setWeeklyAllowance(fixture.db, fixture.userId, tokens), {
      instanceOf: RangeError,
    });
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId), null);
});
