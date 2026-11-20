// The run loop against recorded provider streams and an in-memory store
// (`04-agent-runtime.md` §3, `05-run-lifecycle-and-streaming.md` §4-§7,
// `12-testing-linting-ci.md` §3.3). Each test picks its scenario with a
// `fixture:<scenario>` marker in the question, so the tests share no state.

import type { Turn } from "@session/shared";
import test from "ava";

import { hasAnswerText } from "../src/runs/loop.js";
import type { Providers } from "../src/runs/providers.js";

import type { LoopHarness, StoreCall } from "./runsHelpers.js";
import { createLoopHarness } from "./runsHelpers.js";

function usageRows(harness: LoopHarness, runId: string): { kind: string; n: number }[] {
  return harness.db.$client
    .prepare(
      "SELECT kind, count(*) AS n FROM usage_events WHERE node_id = ? GROUP BY kind ORDER BY kind",
    )
    .all(runId) as { kind: string; n: number }[];
}

/** Resolves once the store has seen a call of `kind` for `runId`. */
async function waitFor(harness: LoopHarness, runId: string, kind: StoreCall["kind"]) {
  for (let tries = 0; tries < 500; tries += 1) {
    if (harness.store.calls.some((call) => call.runId === runId && call.kind === kind)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${kind} for ${runId}`);
}

test("an attempt streams, commits its turns, and completes with an answer", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("asker");
  const request = harness.runRequest(user.id, "What is a bloom filter? fixture:success-with-tools");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "complete");

  const calls = harness.store.calls.filter((call) => call.runId === request.runId);
  t.is(calls[0]?.kind, "markRunning");
  t.true(calls.some((call) => call.kind === "delta"));
  const committed = calls.filter((call) => call.kind === "commitTurn");
  t.true(committed.length >= 2, "a tool step commits its own turns");

  const [finish] = harness.store.finishes(request.runId);
  t.is(finish?.summary.outcome, "complete");
  t.true((finish?.summary.steps ?? 0) >= 2);
  t.true((finish?.summary.toolCalls ?? 0) > 0);
  t.true((finish?.summary.usage.inputTokens ?? 0) > 0);
  t.is(finish?.answer?.turns.length, committed.length);
  // The question comes first, so a follow-up replays alternating turns.
  t.deepEqual(finish?.answer?.messages[0], { role: "user", content: request.userText });
  t.is(calls.at(-1)?.kind, "finish", "the outcome is the last write");

  const rows = usageRows(harness, request.runId);
  t.deepEqual(
    rows.find((row) => row.kind === "run"),
    { kind: "run", n: 1 },
    "one run row per attempt, for the daily run limit",
  );
  t.true(rows.some((row) => row.kind === "research"));
  t.true(rows.some((row) => row.kind === "search" || row.kind === "fetch"));
});

test("a provider failure fails the attempt with its classified error", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("unlucky");
  const request = harness.runRequest(user.id, "fixture:mid-stream-error");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "failed");
  const [finish] = harness.store.finishes(request.runId);
  t.is(finish?.summary.outcome, "failed");
  t.truthy(finish?.summary.error?.message);
  t.is(finish?.answer, undefined);
});

test("a 429 ends the attempt rate_limited for the dispatcher to queue again", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("limited");
  const request = harness.runRequest(user.id, "fixture:rate-limit");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "rate_limited");
  t.is(result.error?.errorClass, "rate_limited");
  t.is(harness.store.finishes(request.runId)[0]?.summary.outcome, "rate_limited");
});

test("a refusal fails the attempt", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("refused");
  const request = harness.runRequest(user.id, "fixture:refusal");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "failed");
  t.is(result.error?.errorClass, "content_filter");
});

test("an unconfigured model fails before anything streams", async (t) => {
  const providers: Providers = { fixtures: true, resolve: () => null };
  const harness = createLoopHarness(t, { providers });
  const user = harness.addUser("misconfigured");
  const request = harness.runRequest(user.id, "fixture:success");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "failed");
  t.is(result.error?.errorClass, "auth");
  t.deepEqual(
    harness.store.calls.map((call) => call.kind),
    ["finish"],
  );
});

test("a cancel aborts the stream and records the attempt cancelled", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("canceller");
  const request = harness.runRequest(user.id, "fixture:paced-answer");

  const running = harness.agent.run(request);
  await waitFor(harness, request.runId, "delta");
  harness.store.cancelled.add(request.runId);
  harness.agent.cancel(request.runId);

  t.is((await running).outcome, "cancelled");
  t.is(harness.store.finishes(request.runId)[0]?.summary.outcome, "cancelled");
  t.true(usageRows(harness, request.runId).some((row) => row.kind === "research"));
});

test("a drain keeps the partial text and records the attempt interrupted", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("drained");
  const request = harness.runRequest(user.id, "fixture:paced-answer");

  const running = harness.agent.run(request);
  await waitFor(harness, request.runId, "delta");
  await harness.agent.drain();

  t.is((await running).outcome, "interrupted");
  const calls = harness.store.calls.filter((call) => call.runId === request.runId);
  // The partial step is committed when the stream ends, so the resume
  // replays it.
  t.true(
    calls.some(
      (call) =>
        call.kind === "commitTurn" &&
        call.turn.blocks.some((block) => block.type === "text" && block.text !== ""),
    ),
    "the partial text is kept for the resume",
  );
  t.is(calls.at(-1)?.kind, "finish");
  t.is(harness.store.finishes(request.runId)[0]?.summary.outcome, "interrupted");
  // A drained service starts nothing more.
  t.is((await harness.agent.run(harness.runRequest(user.id, "late"))).outcome, "superseded");
});

test("an attempt superseded by a newer one records usage and writes nothing else", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("retrier");
  const request = harness.runRequest(user.id, "fixture:paced-answer");

  const running = harness.agent.run(request);
  await waitFor(harness, request.runId, "delta");
  const before = harness.store.calls.length;
  // A retry started attempt 2; then this attempt's stream ends.
  harness.store.attempts.set(request.runId, 2);
  harness.agent.cancel(request.runId);

  t.is((await running).outcome, "superseded");
  t.is(harness.store.calls.length, before, "no write after the newer attempt began");
  t.true(usageRows(harness, request.runId).some((row) => row.kind === "research"));
});

test("a resume replays the committed turns and keeps them in the answer", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("resumer");
  const request = harness.runRequest(user.id, "fixture:success", { kind: "resume" });
  const earlier: Turn = {
    id: `${request.runId}-assistant-0`,
    agentId: request.runId,
    role: "assistant",
    blocks: [{ type: "text", text: "The first part of the answer." }],
    sourceIndex: 0,
  };
  harness.store.committed.set(request.runId, [earlier]);

  t.is((await harness.agent.run(request)).outcome, "complete");
  const answer = harness.store.finishes(request.runId)[0]?.answer;
  t.deepEqual(answer?.turns[0], earlier);
  t.true((answer?.turns.length ?? 0) > 1);
  t.true(
    answer?.turns.slice(1).every((turn) => turn.id !== earlier.id),
    "new turns continue past the replayed ones",
  );
});

test("only assistant text counts as an answer", (t) => {
  const turn = (role: Turn["role"], blocks: Turn["blocks"]): Turn => ({
    id: "t",
    agentId: "run",
    role,
    blocks,
    sourceIndex: 0,
  });
  t.false(hasAnswerText([]));
  t.false(hasAnswerText([turn("assistant", [{ type: "text", text: "  " }])]));
  t.false(hasAnswerText([turn("user", [{ type: "text", text: "a tool result" }])]));
  t.true(hasAnswerText([turn("assistant", [{ type: "text", text: "An answer." }])]));
});
