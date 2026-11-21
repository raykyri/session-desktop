// The dispatcher (`03-agents-and-research.md` E2, K10, L1, E5; `01` S5):
// the compare-and-set claim, admission caps, 429 backoff, the payer
// re-check, and boot.

import type { ExecutionContext } from "ava";
import test from "ava";

import { configAllowances } from "../src/runs/allowance.js";
import type { Dispatcher, DispatcherDeps } from "../src/runs/dispatcher.js";
import { MAX_AUTO_RESUMES, RATE_RETRY_AFTER_MS, createDispatcher } from "../src/runs/dispatcher.js";
import { RATE_LIMIT_BACKOFF_MS } from "../src/runs/errors.js";
import { weekOf } from "../src/runs/ledger.js";
import type { AttemptResult } from "../src/runs/loop.js";
import type { QueuedRun, RunRequest, RunStore } from "../src/runs/store.js";

import type { LoopHarness, LoopHarnessOptions } from "./runsHelpers.js";
import { createLoopHarness, until } from "./runsHelpers.js";

function dispatcherFor(harness: LoopHarness, overrides: Partial<DispatcherDeps> = {}): Dispatcher {
  return createDispatcher({
    config: harness.config,
    store: harness.store,
    ledger: harness.ledger,
    allowances: configAllowances(harness.config),
    runner: harness.agent,
    logger: harness.logger,
    ...overrides,
  });
}

function setup(t: ExecutionContext, options: LoopHarnessOptions = {}): LoopHarness {
  return createLoopHarness(t, options);
}

test("the claim is a compare-and-set: of two claims of one queued attempt, one wins", (t) => {
  const harness = setup(t);
  const user = harness.addUser("claimed");
  harness.store.enqueue({ runId: "run-cas", userId: user.id, userText: "fixture:success" });
  const [queued] = harness.store.queued();

  const first = harness.store.claim(queued!);
  const second = harness.store.claim(queued!);
  t.truthy(first);
  t.is(second, null);
  t.is(harness.store.runs.get("run-cas")?.claims, 1);
  // A claim of an attempt that is no longer current changes nothing.
  t.is(harness.store.claim({ ...queued!, attempt: 2 }), null);
});

test("two dispatchers reading the same queue start one runner per attempt", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("raced");
  for (const runId of ["race-1", "race-2"]) {
    harness.store.enqueue({ runId, userId: user.id, userText: "fixture:success" });
  }
  // Both dispatchers read the queue before either claims, as two
  // transactions running side by side would.
  const snapshot: QueuedRun[] = harness.store.queued();
  const staleView: RunStore = Object.create(harness.store) as RunStore;
  staleView.queued = () => snapshot;
  const a = dispatcherFor(harness, { store: staleView });
  const b = dispatcherFor(harness, { store: staleView });

  const started = a.tick() + b.tick();
  t.is(started, 2, "each attempt started once");
  await Promise.all([a.idle(), b.idle()]);
  for (const runId of ["race-1", "race-2"]) {
    t.is(harness.store.runs.get(runId)?.claims, 1);
    t.is(harness.store.runs.get(runId)?.status, "complete");
    t.is(
      harness.store.calls.filter((c) => c.kind === "markRunning" && c.runId === runId).length,
      1,
    );
  }
});

test("at most two of a member's runs run at once, oldest first", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("busy");
  for (const runId of ["busy-1", "busy-2", "busy-3"]) {
    harness.store.enqueue({ runId, userId: user.id, userText: "fixture:paced-answer" });
  }
  const dispatcher = dispatcherFor(harness);

  t.is(dispatcher.tick(), 2);
  t.is(harness.store.runs.get("busy-3")?.status, "queued");
  t.is(dispatcher.tick(), 0, "the third waits for a slot");
  harness.store.cancelled.add("busy-1");
  harness.agent.cancel("busy-1");
  await until(() => harness.store.runs.get("busy-1")?.status === "cancelled", "the cancel");
  await until(
    () => dispatcher.tick() === 1 || harness.store.runs.get("busy-3")?.status !== "queued",
  );
  t.is(harness.store.runs.get("busy-3")?.status, "running");
  for (const runId of ["busy-2", "busy-3"]) {
    harness.store.cancelled.add(runId);
    harness.agent.cancel(runId);
  }
  await dispatcher.idle();
});

test("the per-provider cap holds across members", async (t) => {
  const harness = setup(t, { env: { SESSION_RUNS_GEMINI: "1" } });
  const one = harness.addUser("one");
  const two = harness.addUser("two");
  harness.store.enqueue({ runId: "gem-1", userId: one.id, userText: "fixture:paced-answer" });
  harness.store.enqueue({ runId: "gem-2", userId: two.id, userText: "fixture:paced-answer" });
  harness.store.enqueue({
    runId: "fable-1",
    userId: two.id,
    model: "claude-fable",
    userText: "fixture:paced-answer",
  });
  const dispatcher = dispatcherFor(harness);

  t.is(dispatcher.tick(), 2);
  t.is(harness.store.runs.get("gem-1")?.status, "running");
  t.is(harness.store.runs.get("gem-2")?.status, "queued", "Gemini is at its cap");
  t.is(harness.store.runs.get("fable-1")?.status, "running", "another provider is not");
  for (const runId of ["gem-1", "fable-1"]) {
    harness.store.cancelled.add(runId);
    harness.agent.cancel(runId);
  }
  await dispatcher.idle();
});

test("a 429 is re-queued with backoff three times, then fails rate", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("throttled");
  harness.store.enqueue({ runId: "run-429", userId: user.id, userText: "fixture:rate-limit" });
  let now = 1_000_000;
  const dispatcher = dispatcherFor(harness, { now: () => now, backoffMs: [5_000, 20_000, 60_000] });
  const run = harness.store.runs.get("run-429")!;

  for (const wait of [5_000, 20_000, 60_000]) {
    t.is(dispatcher.tick(), 1);
    await dispatcher.idle();
    t.is(run.status, "queued", "re-queued");
    now += wait - 1;
    t.is(dispatcher.tick(), 0, "waits out the backoff");
    now += 1;
  }
  t.is(dispatcher.tick(), 1);
  await dispatcher.idle();

  t.is(run.status, "failed");
  t.deepEqual(run.last?.fail, { why: "rate", at: now + RATE_RETRY_AFTER_MS });
  const rows = harness.ledger.rows({ runId: "run-429" });
  t.is(rows.length, 4, "each retry opens a new row");
  t.true(rows.every((row) => row.state === "closed" && row.counted === 0));
  t.is(run.last?.tok, 0);
});

test("a queued run admitted after the allowance is spent ends tokens without a provider call", (t) => {
  const harness = setup(t, { env: { SESSION_WEEKLY_TOKENS: "1000" } });
  const user = harness.addUser("broke");
  const spent = harness.ledger.open({
    runId: "earlier",
    attempt: 1,
    userId: user.id,
    payer: "included",
    week: weekOf(Date.now()),
    kind: "research",
    provider: "vertex",
    model: "gemini-flash",
    cachedInputRatio: 0.1,
    counts: { inputTokens: 1_000, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    openedAt: Date.now(),
  });
  t.truthy(spent, "an open row counts");
  harness.store.enqueue({ runId: "run-broke", userId: user.id, userText: "fixture:success" });
  const dispatcher = dispatcherFor(harness);

  t.is(dispatcher.tick(), 0);
  const run = harness.store.runs.get("run-broke")!;
  t.is(run.status, "failed");
  t.deepEqual(run.last?.fail, { why: "tokens" });
  t.is(run.claims, 0);
  t.deepEqual(harness.streamed, [], "no provider call");
  t.deepEqual(harness.ledger.rows({ runId: "run-broke" }), []);
});

test("boot closes open rows, interrupts running runs and resumes them at most twice", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("crashed");
  harness.ledger.open({
    runId: "run-crashed",
    attempt: 1,
    userId: user.id,
    payer: "included",
    week: weekOf(Date.now()),
    kind: "research",
    provider: "vertex",
    model: "gemini-flash",
    cachedInputRatio: 0.1,
    counts: { inputTokens: 300, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    openedAt: Date.now(),
  });
  const crashed = harness.store.enqueue({
    runId: "run-crashed",
    userId: user.id,
    userText: "fixture:success",
    status: "running",
  });
  crashed.turns.set(1, [
    {
      id: "run-crashed-assistant-0",
      agentId: "run-crashed",
      role: "assistant",
      blocks: [{ type: "text", text: "The first part." }],
      sourceIndex: 0,
    },
  ]);
  const drained = harness.store.enqueue({
    runId: "run-drained",
    userId: user.id,
    userText: "fixture:success",
    status: "interrupted",
    resumes: 1,
  });
  const spent = harness.store.enqueue({
    runId: "run-spent",
    userId: user.id,
    userText: "fixture:success",
    status: "interrupted",
    resumes: MAX_AUTO_RESUMES,
  });
  const dispatcher = dispatcherFor(harness);

  t.deepEqual(dispatcher.boot(), { closedRows: 1, interrupted: 1, resumed: 2, sweptLive: 0 });
  t.like(harness.ledger.rows({ runId: "run-crashed" })[0], { state: "closed", ending: "boot" });
  t.is(crashed.status, "queued");
  t.is(crashed.resumes, 1);
  t.is(drained.status, "queued");
  t.is(drained.resumes, 2);
  t.is(spent.status, "interrupted", "two automatic resumes, then Run again");

  t.is(dispatcher.tick(), 2);
  await dispatcher.idle();
  t.is(crashed.status, "complete");
  const answer = harness.store.finishes("run-crashed")[0]?.answer;
  t.is(answer?.turns[0]?.id, "run-crashed-assistant-0", "the resume replays the committed turns");
  t.is(drained.status, "complete");
});

test("a started dispatcher picks up a run it is woken for", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("woken");
  const dispatcher = dispatcherFor(harness, { pollMs: 60_000 });
  dispatcher.start();
  t.teardown(() => dispatcher.stop());

  harness.store.enqueue({ runId: "run-woken", userId: user.id, userText: "fixture:success" });
  dispatcher.wake();
  await until(() => harness.store.runs.get("run-woken")?.status === "complete", "the run");
  t.pass();
});

test("E4: a run's new attempt is not claimed while its older attempt still settles here", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("retrier");
  const run = harness.store.enqueue({ runId: "run-e4", userId: user.id, userText: "x" });
  const started: number[] = [];
  let settle: () => void = () => undefined;
  const runner = {
    run: (request: RunRequest): Promise<AttemptResult> => {
      started.push(request.attempt);
      if (request.attempt > 1) return Promise.resolve({ outcome: "complete" });
      return new Promise((resolve) => {
        settle = () => resolve({ outcome: "cancelled" });
      });
    },
  };
  const dispatcher = dispatcherFor(harness, { runner });
  t.is(dispatcher.tick(), 1);
  // Stop, then Run again: attempt 2 is queued while attempt 1 settles
  run.status = "queued";
  run.attempt = 2;
  t.is(dispatcher.tick(), 0);
  t.is(run.status, "queued");
  t.deepEqual(started, [1]);
  settle();
  await dispatcher.idle();
  t.is(dispatcher.tick(), 1);
  t.deepEqual(started, [1, 2]);
  await dispatcher.idle();
});

test("E5: the default 429 backoff is 5 s, 20 s and 60 s, then the run fails rate", async (t) => {
  const harness = setup(t);
  const user = harness.addUser("defaults");
  harness.store.enqueue({ runId: "run-default", userId: user.id, userText: "fixture:rate-limit" });
  let now = 2_000_000;
  const dispatcher = dispatcherFor(harness, { now: () => now });
  const run = harness.store.runs.get("run-default")!;
  t.deepEqual([...RATE_LIMIT_BACKOFF_MS], [5_000, 20_000, 60_000]);
  for (const wait of [5_000, 20_000, 60_000]) {
    t.is(dispatcher.tick(), 1);
    await dispatcher.idle();
    t.is(run.status, "queued");
    now += wait - 1;
    t.is(dispatcher.tick(), 0, `waits ${wait} ms`);
    now += 1;
  }
  t.is(dispatcher.tick(), 1);
  await dispatcher.idle();
  t.deepEqual(run.last?.fail, { why: "rate", at: now + RATE_RETRY_AFTER_MS });
});
