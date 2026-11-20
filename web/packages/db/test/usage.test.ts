import test from "ava";

import { auth, usage } from "../src/index.js";

import { createFixture } from "./helpers.js";

const DAY = 86_400_000;
const NOON = Math.floor(1_700_000_000_000 / DAY) * DAY + DAY / 2;

// NOON is a Tuesday: its UTC week runs from the Monday before (NOON - 1.5
// days) to the next Monday.
test("weekly totals sum one UTC week (Monday 00:00) and count run starts as runs", (t) => {
  const fixture = createFixture(t);
  usage.record(fixture.db, fixture.userId, {
    runId: "R1",
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
    at: NOON + 4 * DAY,
  });
  // the Sunday before and the Monday after are other weeks
  for (const at of [NOON - 2 * DAY, NOON + 6 * DAY])
    usage.record(fixture.db, fixture.userId, {
      kind: "research",
      provider: "vertex",
      inputTokens: 1_000_000,
      at,
    });
  for (const at of [NOON, NOON - DAY, NOON - 2 * DAY, NOON + 6 * DAY])
    usage.record(fixture.db, fixture.userId, { kind: "run", provider: "vertex", at });
  const totals = usage.weeklyTotals(fixture.db, fixture.userId, NOON);
  t.is(totals.inputTokens, 105);
  t.is(totals.outputTokens, 205);
  t.is(totals.reasoningTokens, 50);
  t.is(totals.cachedTokens, 10);
  t.is(totals.costEstimateMicros, 7);
  t.is(totals.runs, 2, "only run starts inside the week are runs");
  t.is(usage.weeklyTotals(fixture.db, "someone-else", NOON).runs, 0);
});

test("the weekly allowance is the person's own, else the deployment's", (t) => {
  const fixture = createFixture(t);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId, 250_000), 250_000);
  auth.setUserLimits(fixture.db, fixture.userId, 40_000);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId, 250_000), 40_000);
  auth.setUserLimits(fixture.db, fixture.userId, 0);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId, 250_000), 0, "zero is an allowance");
  auth.setUserLimits(fixture.db, fixture.userId, null);
  t.is(usage.weeklyAllowance(fixture.db, fixture.userId, 250_000), 250_000);
});

test("monthly usage by payer and space, for /api/me/usage", (t) => {
  const fixture = createFixture(t);
  const month = usage.monthOf(NOON);
  const rec = (payer: string | null, spaceId: string, tokens: number, at = NOON) =>
    usage.record(fixture.db, fixture.userId, {
      runId: "R",
      spaceId,
      payer,
      kind: "research",
      provider: "anthropic",
      inputTokens: tokens,
      outputTokens: tokens,
      at,
    });
  rec("session", "S1", 10);
  rec("session", "S1", 5);
  rec("session", "S2", 1);
  rec("K1", "S1", 100);
  rec(null, "S1", 1000);
  rec("session", "S1", 7, month.start - 1);
  usage.record(fixture.db, fixture.userId, {
    payer: "session",
    kind: "run",
    provider: "x",
    at: NOON,
  });
  t.deepEqual(usage.monthlyByPayer(fixture.db, fixture.userId, NOON), {
    session: { S1: 30, S2: 2 },
    K1: { S1: 200 },
  });
  t.is(usage.monthlyUsed(fixture.db, fixture.userId, "session", NOON), 32);
  t.is(usage.tokensOfRun(fixture.db, "R"), 2 * (10 + 5 + 1 + 100 + 1000 + 7));
});

test("weekly included tokens: Monday 00:00 UTC to the next Monday", (t) => {
  const fixture = createFixture(t);
  // Thursday 2026-11-19 12:00 UTC: the week is Monday the 16th to Monday the 23rd
  const at = Date.UTC(2026, 10, 19, 12);
  const week = usage.weekOf(at);
  t.is(week.start, Date.UTC(2026, 10, 16));
  t.is(week.end, Date.UTC(2026, 10, 23));
  // a Monday is the first day of its own week, and a Sunday the last
  t.is(usage.weekOf(Date.UTC(2026, 10, 16)).start, Date.UTC(2026, 10, 16));
  t.is(usage.weekOf(Date.UTC(2026, 10, 22, 23, 59)).start, Date.UTC(2026, 10, 16));
  const rec = (payer: string, tokens: number, when: number) =>
    usage.record(fixture.db, fixture.userId, {
      runId: "R",
      spaceId: "S1",
      payer,
      kind: "research",
      provider: "anthropic",
      inputTokens: tokens,
      outputTokens: 0,
      at: when,
    });
  rec("session", 10, week.start);
  rec("session", 20, week.end - 1);
  rec("session", 400, week.start - 1);
  rec("session", 800, week.end);
  rec("K1", 5, at);
  t.is(usage.weeklyUsed(fixture.db, fixture.userId, "session", at), 30);
  t.is(usage.weeklyUsed(fixture.db, fixture.userId, "K1", at), 5);
});
