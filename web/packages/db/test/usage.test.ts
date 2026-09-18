import test from "ava";

import { auth, runs, trees, usage } from "../src/index.js";

import type { Fixture } from "./helpers.js";
import { createFixture } from "./helpers.js";

const DAY = 86_400_000;
const NOON = Math.floor(1_700_000_000_000 / DAY) * DAY + DAY / 2;

/** One research attempt started at `at`. `daily_runs` counts `run_attempts`
 * rows rather than `usage_events`, so an attempt that reports its usage in
 * several records is still one run. */
function attemptAt(fixture: Fixture, at: number): string {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: `Question at ${at}`,
    model: "gemini-flash",
  });
  runs.startAttempt(fixture.db, {
    nodeId: detail.tree.rootNodeId,
    attempt: 1,
    kind: "fresh",
    model: "gemini-flash",
    at,
  });
  return detail.tree.rootNodeId;
}

test("daily totals sum one UTC day and count research attempts as runs", (t) => {
  const fixture = createFixture(t);
  usage.record(fixture.db, fixture.userId, {
    kind: "research",
    provider: "vertex",
    inputTokens: 100,
    outputTokens: 200,
    reasoningTokens: 50,
    cachedTokens: 10,
    costEstimateMicros: 7,
    at: NOON,
  });
  usage.record(fixture.db, fixture.userId, {
    kind: "metadata",
    provider: "vertex",
    inputTokens: 5,
    outputTokens: 5,
    at: NOON + 1000,
  });
  // Yesterday and tomorrow are outside the window.
  usage.record(fixture.db, fixture.userId, {
    kind: "research",
    provider: "vertex",
    inputTokens: 1_000_000,
    at: NOON - DAY,
  });
  usage.record(fixture.db, fixture.userId, {
    kind: "research",
    provider: "vertex",
    inputTokens: 1_000_000,
    at: NOON + DAY,
  });

  // One attempt today, one on each neighbouring day.
  attemptAt(fixture, NOON);
  attemptAt(fixture, NOON - DAY);
  attemptAt(fixture, NOON + DAY);

  const totals = usage.dailyTotals(fixture.db, fixture.userId, NOON);
  t.is(totals.day, NOON - DAY / 2);
  t.is(totals.inputTokens, 105);
  t.is(totals.outputTokens, 205);
  t.is(totals.reasoningTokens, 50);
  t.is(totals.cachedTokens, 10);
  t.is(totals.costEstimateMicros, 7);
  t.is(totals.runs, 1, "only attempts started inside the day are runs");
});

test("an attempt that reports usage several times is still one run", (t) => {
  const fixture = createFixture(t);
  const nodeId = attemptAt(fixture, NOON);
  for (const inputTokens of [10, 20, 30]) {
    usage.record(fixture.db, fixture.userId, {
      nodeId,
      kind: "research",
      provider: "vertex",
      inputTokens,
      at: NOON,
    });
  }
  const totals = usage.dailyTotals(fixture.db, fixture.userId, NOON);
  t.is(totals.inputTokens, 60);
  t.is(totals.runs, 1, "the limit counts attempts, not usage records");
});

test("a retry is a second run against the daily limit", (t) => {
  const fixture = createFixture(t);
  const nodeId = attemptAt(fixture, NOON);
  runs.startAttempt(fixture.db, {
    nodeId,
    attempt: 2,
    kind: "resume",
    model: "gemini-flash",
    at: NOON + 1000,
  });
  t.is(usage.dailyTotals(fixture.db, fixture.userId, NOON).runs, 2);
});

test("another account's attempts are not counted", (t) => {
  const fixture = createFixture(t);
  attemptAt(fixture, NOON);
  t.is(usage.dailyTotals(fixture.db, "someone-else", NOON).runs, 0);
});

test("prioritizes account-specific limits over deployment defaults", (t) => {
  const fixture = createFixture(t);
  t.deepEqual(usage.effectiveLimits(fixture.db, fixture.userId), {
    dailyTokens: usage.DEFAULT_DAILY_TOKENS,
    dailyRuns: usage.DEFAULT_DAILY_RUNS,
  });
  t.deepEqual(usage.effectiveLimits(fixture.db, fixture.userId, { dailyRuns: 3 }), {
    dailyTokens: usage.DEFAULT_DAILY_TOKENS,
    dailyRuns: 3,
  });
  auth.setUserLimits(fixture.db, fixture.userId, { dailyRuns: 50 });
  t.is(usage.effectiveLimits(fixture.db, fixture.userId, { dailyRuns: 3 }).dailyRuns, 50);
});

test("returns remaining quota metrics and rejection reason when limit is reached", (t) => {
  const fixture = createFixture(t);
  const defaults = { dailyTokens: 1000, dailyRuns: 2 };
  t.deepEqual(usage.admissionCheck(fixture.db, fixture.userId, { defaults, at: NOON }), {
    allowed: true,
    remainingTokens: 1000,
    remainingRuns: 2,
  });

  attemptAt(fixture, NOON);
  usage.record(fixture.db, fixture.userId, {
    kind: "research",
    provider: "vertex",
    inputTokens: 400,
    outputTokens: 400,
    reasoningTokens: 100,
    cachedTokens: 900,
    at: NOON,
  });
  const partial = usage.admissionCheck(fixture.db, fixture.userId, { defaults, at: NOON });
  t.true(partial.allowed);
  t.is(
    partial.remainingTokens,
    200,
    "cached tokens are reported but not charged, and reasoning is already inside the output count",
  );
  t.is(partial.remainingRuns, 1);

  attemptAt(fixture, NOON);
  const blocked = usage.admissionCheck(fixture.db, fixture.userId, { defaults, at: NOON });
  t.false(blocked.allowed);
  t.is(blocked.reason, "runs");

  // Quotas reset at 00:00 UTC.
  t.true(usage.admissionCheck(fixture.db, fixture.userId, { defaults, at: NOON + DAY }).allowed);
});

test("reports token exhaustion with a specific quota exceeded error", (t) => {
  const fixture = createFixture(t);
  usage.record(fixture.db, fixture.userId, {
    kind: "metadata",
    provider: "vertex",
    inputTokens: 5000,
    at: NOON,
  });
  const decision = usage.admissionCheck(fixture.db, fixture.userId, {
    defaults: { dailyTokens: 1000, dailyRuns: 10 },
    at: NOON,
  });
  t.false(decision.allowed);
  t.is(decision.reason, "tokens");
  t.is(decision.remainingTokens, 0);
});

test("admins are exempt", (t) => {
  const fixture = createFixture(t);
  usage.record(fixture.db, fixture.userId, {
    kind: "research",
    provider: "vertex",
    inputTokens: 10_000_000,
    at: NOON,
  });
  t.deepEqual(usage.admissionCheck(fixture.db, fixture.userId, { isAdmin: true, at: NOON }), {
    allowed: true,
    remainingTokens: null,
    remainingRuns: null,
  });
});

test("the summary carries the day's counts and the limits in force", (t) => {
  const fixture = createFixture(t);
  attemptAt(fixture, NOON);
  usage.record(fixture.db, fixture.userId, {
    kind: "research",
    provider: "vertex",
    inputTokens: 1,
    at: NOON,
  });
  const summary = usage.summary(fixture.db, fixture.userId, { dailyTokens: 5, dailyRuns: 6 }, NOON);
  t.is(summary.inputTokens, 1);
  t.is(summary.runs, 1);
  t.is(summary.dailyTokenLimit, 5);
  t.is(summary.dailyRunLimit, 6);
});
