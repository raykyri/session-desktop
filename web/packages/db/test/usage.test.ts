import test from "ava";

import { auth, usage } from "../src/index.js";

import { createFixture } from "./helpers.js";

const DAY = 86_400_000;
const NOON = Math.floor(1_700_000_000_000 / DAY) * DAY + DAY / 2;

test("daily totals sum one UTC day and count run starts as runs", (t) => {
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
    at: NOON + 1000,
  });
  for (const at of [NOON - DAY, NOON + DAY])
    usage.record(fixture.db, fixture.userId, {
      kind: "research",
      provider: "vertex",
      inputTokens: 1_000_000,
      at,
    });
  for (const at of [NOON, NOON - DAY, NOON + DAY])
    usage.record(fixture.db, fixture.userId, { kind: "run", provider: "vertex", at });
  const totals = usage.dailyTotals(fixture.db, fixture.userId, NOON);
  t.is(totals.day, NOON - DAY / 2);
  t.is(totals.inputTokens, 105);
  t.is(totals.outputTokens, 205);
  t.is(totals.reasoningTokens, 50);
  t.is(totals.cachedTokens, 10);
  t.is(totals.costEstimateMicros, 7);
  t.is(totals.runs, 1, "only run starts inside the day are runs");
  t.is(usage.dailyTotals(fixture.db, "someone-else", NOON).runs, 0);
});

test("the admission check follows the per-account overrides", (t) => {
  const fixture = createFixture(t);
  usage.record(fixture.db, fixture.userId, { kind: "run", provider: "vertex", at: NOON });
  t.true(
    usage.admissionCheck(fixture.db, fixture.userId, { defaults: { dailyRuns: 2 }, at: NOON })
      .allowed,
  );
  auth.setUserLimits(fixture.db, fixture.userId, { dailyRuns: 1 });
  const d = usage.admissionCheck(fixture.db, fixture.userId, {
    defaults: { dailyRuns: 2 },
    at: NOON,
  });
  t.false(d.allowed);
  t.is(d.reason, "runs");
  t.true(usage.admissionCheck(fixture.db, fixture.userId, { isAdmin: true, at: NOON }).allowed);
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
