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

test("I2: extra_invites starts at 0, grows by each grant, and keeps the weekly allowance", (t) => {
  const fixture = createFixture(t);
  t.deepEqual(usage.memberLimits(fixture.db, fixture.userId), {
    weeklyTokens: null,
    extraInvites: 0,
  });
  t.is(usage.addExtraInvites(fixture.db, fixture.userId, 2), 2);
  t.is(usage.addExtraInvites(fixture.db, fixture.userId, 3), 5);
  usage.setWeeklyAllowance(fixture.db, fixture.userId, 4_000_000);
  t.deepEqual(usage.memberLimits(fixture.db, fixture.userId), {
    weeklyTokens: 4_000_000,
    extraInvites: 5,
  });
  t.is(usage.addExtraInvites(fixture.db, fixture.userId, 1), 6);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId), 4_000_000);
  const stored = fixture.db.$client
    .prepare("SELECT extra_invites AS extra FROM user_limits WHERE user_id = ?")
    .get(fixture.userId) as { extra: number };
  t.is(stored.extra, 6);
  t.deepEqual(usage.memberLimits(fixture.db, "someone-else"), {
    weeklyTokens: null,
    extraInvites: 0,
  });
});

test("I2: a grant of extra invites is a positive whole number", (t) => {
  const fixture = createFixture(t);
  for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    t.throws(() => usage.addExtraInvites(fixture.db, fixture.userId, count), {
      instanceOf: RangeError,
    });
  t.is(usage.memberLimits(fixture.db, fixture.userId).extraInvites, 0);
});
