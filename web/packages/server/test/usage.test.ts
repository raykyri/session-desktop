// The week's usage and the recent runs (`03-agents-and-research.md` K5, K6):
// `usage.get` and `usage.listRuns` over the ledger, with a run's question
// read through the asker's current scope.

import { usage as usageRepo } from "@session/db";
import test from "ava";

import type { Payer } from "../src/runs/ledger.js";
import { ZERO_COUNTS, weekOf, weekResetAt } from "../src/runs/ledger.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";
import { MemoryRunTexts } from "../src/runs/runTexts.js";

import { createHarness } from "./helpers.js";

/** Tuesday 2026-11-24 12:00 UTC: the week of Friday 2026-11-20. */
const NOW = Date.UTC(2026, 10, 24, 12);
const HOUR = 3_600_000;

function call(
  ledger: MemoryLedger,
  row: { runId: string; userId: string; payer: Payer; at: number; input: number; output?: number },
  close = true,
): void {
  const id = ledger.open({
    runId: row.runId,
    attempt: 1,
    userId: row.userId,
    payer: row.payer,
    week: weekOf(row.at),
    kind: "research",
    provider: "anthropic",
    model: "claude-fable",
    cachedInputRatio: 0.1,
    counts: { ...ZERO_COUNTS, inputTokens: row.input },
    openedAt: row.at,
  });
  if (close) {
    ledger.close(
      id,
      { ...ZERO_COUNTS, inputTokens: row.input, outputTokens: row.output ?? 0 },
      "finish",
      row.at + 1000,
    );
  }
}

test("usage.get: the allowance, included use with open rows counted, the reset and billing", async (t) => {
  const ledger = new MemoryLedger();
  const harness = createHarness(t, { deps: { ledger, now: () => NOW } });
  const user = harness.addUser("reader");
  const other = harness.addUser("other");
  call(ledger, {
    runId: "r1",
    userId: user.id,
    payer: "included",
    at: NOW - HOUR,
    input: 1_000,
    output: 500,
  });
  // Still streaming: counted as of its last checkpoint.
  call(ledger, { runId: "r2", userId: user.id, payer: "included", at: NOW, input: 300 }, false);
  // Paid by the member's key: recorded, not counted against the allowance.
  call(ledger, { runId: "r3", userId: user.id, payer: "key:anthropic", at: NOW, input: 9_000 });
  // Last week and another member: neither counts.
  call(ledger, {
    runId: "r4",
    userId: user.id,
    payer: "included",
    at: NOW - 7 * 24 * HOUR,
    input: 50_000,
  });
  call(ledger, { runId: "r5", userId: other.id, payer: "included", at: NOW, input: 70_000 });

  const reading = await harness.caller(user).usage.get();
  t.deepEqual(reading, {
    allowance: 2_000_000,
    used: 1_800,
    resetAt: Date.UTC(2026, 10, 27),
    billing: "pause",
    keys: [],
  });
  t.is(reading.resetAt, weekResetAt(NOW));
  await t.throwsAsync(harness.caller(null).usage.get(), { code: "UNAUTHORIZED" });
});

test("usage.listRuns: this week's runs newest first, with the share or the payer", async (t) => {
  const ledger = new MemoryLedger();
  const texts = new MemoryRunTexts();
  const harness = createHarness(t, { deps: { ledger, runTexts: texts, now: () => NOW } });
  const user = harness.addUser("asker");
  const other = harness.addUser("bystander");
  const runs: [string, Payer[], number][] = [
    ["run-included", ["included"], 40_000],
    ["run-tiny", ["included"], 900],
    ["run-anthropic", ["key:anthropic"], 5_000],
    ["run-openai", ["key:openai"], 5_000],
    ["run-split", ["included", "key:anthropic"], 6_000],
  ];
  runs.forEach(([runId, payers, input], index) => {
    texts.set(runId, `Question of ${runId}`, [user.id]);
    for (const payer of payers) {
      call(ledger, { runId, userId: user.id, payer, at: NOW - (10 - index) * HOUR, input });
    }
  });
  call(ledger, { runId: "run-other", userId: other.id, payer: "included", at: NOW, input: 1 });
  call(ledger, {
    runId: "run-old",
    userId: user.id,
    payer: "included",
    at: NOW - 8 * 24 * HOUR,
    input: 1,
  });

  const page = await harness.caller(user).usage.listRuns();
  t.deepEqual(
    page.runs.map((run) => [run.runId, run.question, run.bill, run.tokens]),
    [
      ["run-split", "Question of run-split", "included+key:anthropic", 12_000],
      ["run-openai", "Question of run-openai", "key:openai", 5_000],
      ["run-anthropic", "Question of run-anthropic", "key:anthropic", 5_000],
      ["run-tiny", "Question of run-tiny", "included", 900],
      ["run-included", "Question of run-included", "included", 40_000],
    ],
  );
  t.is(page.runs.find((run) => run.runId === "run-included")?.share, 0.02);
  t.is(page.runs.find((run) => run.runId === "run-split")?.share, 6_000 / 2_000_000);
  t.is(page.runs.find((run) => run.runId === "run-anthropic")?.share, 0);
  t.is(page.runs[0]?.at, NOW - 6 * HOUR);
  t.is(page.nextCursor, null);
});

// TODO(M3, M5a: the SQLite ledger and the RunTexts over the run and node
// records): run this test again against the real store, where removal erases
// the thread's text and `questionOf` reads through the person's current
// scope. Here both halves are the in-memory stand-ins (`MemoryLedger`,
// `MemoryRunTexts`), so the test covers the procedure, not the erasure.
test("a removed thread's run is listed without its question; so is one the person can no longer read", async (t) => {
  const ledger = new MemoryLedger();
  const texts = new MemoryRunTexts();
  const harness = createHarness(t, { deps: { ledger, runTexts: texts, now: () => NOW } });
  const user = harness.addUser("asker");
  for (const [index, runId] of ["kept", "removed", "left"].entries()) {
    texts.set(runId, `The ${runId} question`, [user.id]);
    call(ledger, { runId, userId: user.id, payer: "included", at: NOW - index * HOUR, input: 10 });
  }
  texts.remove("removed");
  texts.revoke("left", user.id);

  const page = await harness.caller(user).usage.listRuns();
  t.deepEqual(
    page.runs.map((run) => [run.runId, run.question, run.missing]),
    [
      ["kept", "The kept question", null],
      ["removed", null, "removed"],
      ["left", null, "unavailable"],
    ],
  );
  t.false(JSON.stringify(page).includes("The removed question"));
  t.false(JSON.stringify(page).includes("The left question"));
  // The tokens stay: removing a thread does not remove its usage.
  t.is(page.runs[1]?.tokens, 10);
});

test("usage.listRuns pages with a cursor; the default page is 6", async (t) => {
  const ledger = new MemoryLedger();
  const harness = createHarness(t, { deps: { ledger, now: () => NOW } });
  const user = harness.addUser("pager");
  for (let index = 0; index < 8; index += 1) {
    call(ledger, {
      runId: `run-${index}`,
      userId: user.id,
      payer: "included",
      at: NOW - index * HOUR,
      input: 1,
    });
  }
  const caller = harness.caller(user);
  const first = await caller.usage.listRuns();
  t.deepEqual(
    first.runs.map((run) => run.runId),
    ["run-0", "run-1", "run-2", "run-3", "run-4", "run-5"],
  );
  t.true(first.runs.every((run) => run.question === null && run.missing === "unavailable"));
  const second = await caller.usage.listRuns({ cursor: first.nextCursor });
  t.deepEqual(
    second.runs.map((run) => run.runId),
    ["run-6", "run-7"],
  );
  t.is(second.nextCursor, null);
  // A cursor whose run is no longer listed pages from where it was.
  const gone = await caller.usage.listRuns({ cursor: `${NOW - 5.5 * HOUR}:run-gone` });
  t.deepEqual(
    gone.runs.map((run) => run.runId),
    ["run-6", "run-7"],
  );
  const small = await caller.usage.listRuns({ limit: 3 });
  t.is(small.runs.length, 3);
  await t.throwsAsync(caller.usage.listRuns({ limit: 0 }));
  for (const cursor of [":run-1", "run-1", "x:run-1", "12:", ""]) {
    await t.throwsAsync(caller.usage.listRuns({ cursor }), { code: "BAD_REQUEST" }, cursor);
  }
});

test("no runs this week lists nothing", async (t) => {
  const harness = createHarness(t, { deps: { now: () => NOW } });
  t.deepEqual(await harness.caller(harness.addUser("idle")).usage.listRuns(), {
    runs: [],
    nextCursor: null,
  });
});

test("K3: at the reset boundary the week's usage and its runs start again", async (t) => {
  const ledger = new MemoryLedger();
  const texts = new MemoryRunTexts();
  /** The last millisecond of the week of Friday 2026-11-20, and the reset. */
  const lastMs = Date.UTC(2026, 10, 26, 23, 59, 59, 999);
  const reset = Date.UTC(2026, 10, 27);
  const clock = { at: lastMs };
  const harness = createHarness(t, { deps: { ledger, runTexts: texts, now: () => clock.at } });
  const user = harness.addUser("weekly");
  texts.set("thursday", "Asked on Thursday", [user.id]);
  call(ledger, {
    runId: "thursday",
    userId: user.id,
    payer: "included",
    at: lastMs - HOUR,
    input: 1_999_000,
  });
  // still streaming at the reset: it counts in the week it started
  call(
    ledger,
    { runId: "late", userId: user.id, payer: "included", at: lastMs - 1, input: 1_000 },
    false,
  );

  const caller = harness.caller(user);
  t.like(await caller.usage.get(), { used: 2_000_000, resetAt: reset });
  t.deepEqual(
    (await caller.usage.listRuns()).runs.map((r) => r.runId),
    ["late", "thursday"],
  );

  clock.at = reset;
  t.like(await caller.usage.get(), {
    used: 0,
    allowance: 2_000_000,
    resetAt: reset + 7 * 24 * HOUR,
  });
  t.deepEqual((await caller.usage.listRuns()).runs, []);
  // a call of the new week counts in it
  call(ledger, { runId: "friday", userId: user.id, payer: "included", at: reset, input: 700 });
  t.like(await caller.usage.get(), { used: 700 });
});

test("K3, K5: a member's allowance override is what usage.listRuns' share is of", async (t) => {
  const ledger = new MemoryLedger();
  const harness = createHarness(t, { deps: { ledger, now: () => NOW } });
  const user = harness.addUser("overridden");
  usageRepo.setWeeklyAllowance(harness.db, user.id, 1_500);
  call(ledger, { runId: "r1", userId: user.id, payer: "included", at: NOW - HOUR, input: 600 });
  const caller = harness.caller(user);
  t.like(await caller.usage.get(), { allowance: 1_500, used: 600 });
  t.like((await caller.usage.listRuns()).runs[0], { runId: "r1", share: 600 / 1_500 });
});
