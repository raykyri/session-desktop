// The ledger at spend time (`03-agents-and-research.md` K1, E1, E5): one row
// per provider call, opened when the call starts, checkpointed, and closed
// however the call ends, with counts that match what the fixture streamed.
// The sum of a run's rows is the run record's `tok`.

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { ModelEntry } from "@session/shared";
import { estimateTokenCount, findModel } from "@session/shared";
import type { ExecutionContext } from "ava";
import test from "ava";

import { OVERDRAFT_STOP_NOTE, RUN_CAP_NOTE } from "../src/runs/allowance.js";
import { registerFixture } from "../src/runs/fixtureProvider.js";
import type { CallEnding } from "../src/runs/ledger.js";
import { ZERO_COUNTS, countedTokens, weekOf } from "../src/runs/ledger.js";
import type { MemoryLedgerRow } from "../src/runs/memoryLedger.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";
import { AttemptMeter } from "../src/runs/meter.js";

import type { LoopHarness, StreamedCall } from "./runsHelpers.js";
import { createLoopHarness, until } from "./runsHelpers.js";

/** 40 ASCII characters: 10 tokens by `estimateTokenCount`. */
const CHUNK = "Tokens are counted while the call runs. ";

/** A one-step answer of `parts` deltas, one every `delayMs`, ending with
 * `finish`. Long enough that a test stops it before it finishes. */
function registerEndless(scenario: string, parts = 3_000, delayMs = 5): void {
  const deltas: LanguageModelV4StreamPart[] = Array.from({ length: parts }, () => ({
    type: "text-delta",
    id: "t0",
    delta: CHUNK,
  }));
  registerFixture({
    scenario,
    steps: [
      {
        delayMs,
        parts: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t0" },
          ...deltas,
          { type: "text-end", id: "t0" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: {
              inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: parts * 10, text: parts * 10, reasoning: 0 },
            },
          },
        ],
      },
    ],
  });
}

registerEndless("endless-answer");

/** The one row of a single-call run, checked closed with `ending`. */
function onlyRow(
  t: ExecutionContext,
  harness: LoopHarness,
  runId: string,
  ending: CallEnding,
): MemoryLedgerRow {
  const rows = harness.ledger.rows({ runId });
  t.is(rows.length, 1, "one provider call, one row");
  const [row] = rows;
  if (!row) throw new Error("no row");
  t.is(row.state, "closed");
  t.is(row.ending, ending);
  return row;
}

/** The output the meter estimates from what a call streamed. */
function streamedOutput(call: StreamedCall | undefined): number {
  return call === undefined || call.output === "" ? 0 : estimateTokenCount(call.output);
}

/** The run record's `tok` equals the sum of its rows. */
function assertTok(t: ExecutionContext, harness: LoopHarness, runId: string): void {
  const [finish] = harness.store.finishes(runId);
  const sum = harness.ledger.rows({ runId }).reduce((total, row) => total + row.counted, 0);
  t.true(sum > 0);
  t.is(finish?.summary.tok, sum, "the run's tok is the sum of its rows");
}

test("counted tokens count cached input at the model's ratio", (t) => {
  const counts = { inputTokens: 1_000, outputTokens: 100, reasoningTokens: 20, cachedTokens: 800 };
  t.is(countedTokens(counts, 0.1), 200 + 80 + 100);
  t.is(countedTokens(counts, 1), 1_100);
  t.is(countedTokens({ ...counts, cachedTokens: 0 }, 0.1), 1_100);
});

test("the week starts on Friday 00:00 UTC", (t) => {
  t.is(weekOf(Date.parse("2026-11-20T00:00:00Z")), "2026-11-20", "a Friday starts its own week");
  t.is(weekOf(Date.parse("2026-11-19T23:59:59Z")), "2026-11-13");
  t.is(weekOf(Date.parse("2026-11-26T12:00:00Z")), "2026-11-20");
});

test("finish: the row closes with the provider's final counts", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("finisher");
  const request = harness.runRequest(user.id, "fixture:success");

  t.is((await harness.agent.run(request)).outcome, "complete");
  const row = onlyRow(t, harness, request.runId, "finish");
  // `success.json` reports 500 input and 60 output tokens, 10 of them reasoning.
  t.deepEqual(row.counts, {
    inputTokens: 500,
    outputTokens: 60,
    reasoningTokens: 10,
    cachedTokens: 0,
  });
  t.like(row, { payer: "included", kind: "research", attempt: 1, userId: user.id });
  t.true(row.writes[0]!.counts.inputTokens > 0, "opened with the request's input");
  assertTok(t, harness, request.runId);
  t.is(harness.store.finishes(request.runId)[0]?.summary.bill, "included");
});

test("cancel: the stream is aborted and the row closes with the last counts", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("canceller");
  const request = harness.runRequest(user.id, "fixture:paced-answer");

  const running = harness.agent.run(request);
  await until(() => harness.store.calls.some((call) => call.kind === "delta"), "a delta");
  harness.store.cancelled.add(request.runId);
  harness.agent.cancel(request.runId);
  t.is((await running).outcome, "cancelled");

  const row = onlyRow(t, harness, request.runId, "cancel");
  t.is(row.counts.inputTokens, row.writes[0]!.counts.inputTokens, "the request's input");
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  t.true(row.counts.outputTokens > 0);
  assertTok(t, harness, request.runId);
});

test("timeout: the stream is aborted and the row closes with the last counts", async (t) => {
  // The fixture's first text arrives about 0.9 s in and the stream never
  // ends; 4 s leaves room for a loaded machine to reach that text.
  const harness = createLoopHarness(t, { env: { SESSION_RUN_TIMEOUT_SECONDS: "4" } });
  const user = harness.addUser("slowpoke");
  const request = harness.runRequest(user.id, "fixture:timeout");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "failed");
  t.is(result.error?.errorClass, "timeout");
  t.deepEqual(harness.store.finishes(request.runId)[0]?.summary.fail, {
    why: "error",
    cls: "timeout",
  });
  const row = onlyRow(t, harness, request.runId, "timeout");
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  t.true(row.counts.outputTokens > 0);
  assertTok(t, harness, request.runId);
});

test("error mid-stream: the row closes with the last counts", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("dropped");
  const request = harness.runRequest(user.id, "fixture:mid-stream-error");

  t.is((await harness.agent.run(request)).outcome, "failed");
  const row = onlyRow(t, harness, request.runId, "error");
  t.is(row.counts.outputTokens, estimateTokenCount("A partial answer that stops "));
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  assertTok(t, harness, request.runId);
});

test("error before streaming: a refused call is closed at 0", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("refused");
  const request = harness.runRequest(user.id, "fixture:context-too-long");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "failed");
  t.is(result.error?.errorClass, "context_too_long");
  const row = onlyRow(t, harness, request.runId, "error");
  t.is(row.counted, 0);
  t.is(harness.store.finishes(request.runId)[0]?.summary.tok, 0);
});

test("superseded: removing the thread aborts the stream, writes nothing after, and closes the row", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("removed");
  const run = harness.store.enqueue({
    runId: "run-removed",
    userId: user.id,
    userText: "fixture:paced-answer",
  });
  const request = harness.store.claim(harness.store.queued()[0]!);
  t.truthy(request);

  const running = harness.agent.run(request!);
  await until(() => harness.store.calls.some((call) => call.kind === "delta"), "a delta");
  run.removed = true;
  const before = harness.store.calls.length;

  t.is((await running).outcome, "superseded");
  t.is(harness.store.calls.length, before, "no record write after the removal");
  t.deepEqual(harness.store.finishes(run.runId), []);
  const row = onlyRow(t, harness, run.runId, "superseded");
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  t.true(row.counts.outputTokens > 0, "billed for what streamed before the abort");
  const parts = harness.streamed[0]?.output ?? "";
  t.false(
    parts.includes("Consistent hashing places both keys and nodes on the same ring"),
    "aborted",
  );
});

test("drain: the attempt is interrupted and the row closes with the last counts", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("drained");
  const request = harness.runRequest(user.id, "fixture:paced-answer");

  const running = harness.agent.run(request);
  await until(() => harness.store.calls.some((call) => call.kind === "delta"), "a delta");
  await harness.agent.drain();
  t.is((await running).outcome, "interrupted");

  const row = onlyRow(t, harness, request.runId, "drain");
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  assertTok(t, harness, request.runId);
});

test("overdraft stop: the run commits its partial step and ends complete with the note", async (t) => {
  const harness = createLoopHarness(t, {
    env: { SESSION_WEEKLY_TOKENS: "1500", SESSION_OVERDRAFT_TOKENS: "1500" },
    ledgerCheckpointMs: 50,
  });
  const user = harness.addUser("spender");
  const request = harness.runRequest(user.id, "fixture:endless-answer");

  const result = await harness.agent.run(request);
  t.is(result.outcome, "complete");
  const [finish] = harness.store.finishes(request.runId);
  t.is(finish?.summary.note, OVERDRAFT_STOP_NOTE);
  const committed = finish?.answer?.turns.at(-1);
  t.true(
    committed?.blocks.some((block) => block.type === "text" && block.text.startsWith(CHUNK)),
    "the partial step is the last turn",
  );

  const row = onlyRow(t, harness, request.runId, "overdraft");
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  t.true(row.counted >= 3_000, "stopped at allowance plus overdraft");
  assertTok(t, harness, request.runId);
});

test("process kill: open rows are closed at boot with their last checkpoint, within one interval", async (t) => {
  const checkpointMs = 100;
  const harness = createLoopHarness(t, { ledgerCheckpointMs: checkpointMs });
  const user = harness.addUser("killed");
  const request = harness.runRequest(user.id, "fixture:endless-answer");

  const running = harness.agent.run(request);
  await until(() => streamedOutput(harness.streamed[0]) > 600, "600 tokens streamed");
  // The kill: the database keeps the rows as last written, and what the
  // provider had streamed at that instant.
  const killedAt = Date.now();
  const onDisk = harness.ledger.crashCopy();
  const streamedAtKill = streamedOutput(harness.streamed[0]);

  harness.store.cancelled.add(request.runId);
  harness.agent.cancel(request.runId);
  await running;

  t.is(onDisk.rows()[0]?.state, "open");
  t.is(onDisk.closeOpen(Date.now()), 1);
  const [row] = onDisk.rows();
  t.is(row?.state, "closed");
  t.is(row?.ending, "boot");
  const billed = row?.counts.outputTokens ?? 0;
  t.true(billed > 0, "checkpoints were written");
  t.true(billed <= streamedAtKill);
  t.true(killedAt - (row?.updatedAt ?? 0) < checkpointMs * 2, "the last checkpoint is recent");
  // At most one checkpoint interval of output goes unbilled.
  const live = harness.ledger.rows({ runId: request.runId })[0]!;
  const perInterval = Math.max(
    ...live.writes.slice(1).map((write, index) => {
      const previous = live.writes[index]!;
      return write.counts.outputTokens - previous.counts.outputTokens;
    }),
  );
  t.true(
    streamedAtKill - billed <= perInterval,
    `unbilled ${streamedAtKill - billed} exceeds one interval (${perInterval})`,
  );
});

test("two concurrent runs of one member never exceed allowance plus overdraft by more than one checkpoint interval", async (t) => {
  const weekly = 2_000;
  const overdraft = 2_000;
  const harness = createLoopHarness(t, {
    env: { SESSION_WEEKLY_TOKENS: String(weekly), SESSION_OVERDRAFT_TOKENS: String(overdraft) },
    ledgerCheckpointMs: 50,
  });
  const user = harness.addUser("twice");
  const first = harness.runRequest(user.id, "fixture:endless-answer");
  const second = harness.runRequest(user.id, "fixture:endless-answer");

  const results = await Promise.all([harness.agent.run(first), harness.agent.run(second)]);
  t.deepEqual(
    results.map((result) => result.outcome),
    ["complete", "complete"],
  );
  for (const request of [first, second]) {
    t.is(harness.store.finishes(request.runId)[0]?.summary.note, OVERDRAFT_STOP_NOTE);
    assertTok(t, harness, request.runId);
  }

  const rows = harness.ledger.rows({ userId: user.id });
  const total = rows.reduce((sum, row) => sum + row.counted, 0);
  t.is(total, harness.ledger.includedUsage(user.id, weekOf(Date.now())));
  // One checkpoint interval of output: the most either row grew between two
  // consecutive writes, for each run.
  const interval = rows.map((row) =>
    Math.max(
      ...row.writes.slice(1).map((write, index) => {
        return write.counts.outputTokens - row.writes[index]!.counts.outputTokens;
      }),
    ),
  );
  const bound = weekly + overdraft + interval.reduce((sum, value) => sum + value, 0);
  t.true(total >= weekly + overdraft);
  t.true(total <= bound, `spent ${total}, bound ${bound}`);
});

test("K9: the step boundary counts the next request's input: a request that would pass the overdraft limit is not made", async (t) => {
  const harness = createLoopHarness(t, {
    env: { SESSION_WEEKLY_TOKENS: "500", SESSION_OVERDRAFT_TOKENS: "500" },
  });
  const user = harness.addUser("boundary");
  // a question of about 3,000 tokens: every request of the run is larger
  // than the limit, while the first step is billed 940 by the provider
  const request = harness.runRequest(user.id, `${"word ".repeat(2_400)}fixture:success-with-tools`);

  t.is((await harness.agent.run(request)).outcome, "complete");
  t.is(harness.store.finishes(request.runId)[0]?.summary.note, OVERDRAFT_STOP_NOTE);
  const rows = harness.ledger.rows({ runId: request.runId });
  t.deepEqual(
    rows.map((row) => [row.ending, row.counted]),
    [["finish", 940]],
    "no request after the first step",
  );
  t.is(harness.ledger.includedUsage(user.id, weekOf(Date.now())), 940);
  assertTok(t, harness, request.runId);
});

test("the run's token cap ends it complete with its note", async (t) => {
  const harness = createLoopHarness(t, {
    env: { SESSION_RUN_MAX_TOKENS: "2500" },
    ledgerCheckpointMs: 50,
  });
  const user = harness.addUser("capped");
  const request = harness.runRequest(user.id, "fixture:endless-answer");

  t.is((await harness.agent.run(request)).outcome, "complete");
  t.is(harness.store.finishes(request.runId)[0]?.summary.note, RUN_CAP_NOTE);
  const row = onlyRow(t, harness, request.runId, "run_cap");
  t.true(row.counted >= 2_500);
  t.is(row.counts.outputTokens, streamedOutput(harness.streamed[0]));
  assertTok(t, harness, request.runId);
});

test("the title and summary steps are billed to the run and fenced", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("titled");
  const request = harness.runRequest(user.id, "What is a skip list? fixture:success", {
    finalSteps: { title: true, summary: true },
  });

  t.is((await harness.agent.run(request)).outcome, "complete");
  const kinds = harness.store.calls
    .filter((call) => call.runId === request.runId)
    .map((call) => call.kind);
  t.deepEqual(kinds.slice(-3), ["title", "summary", "finish"], "the run's final steps");
  t.deepEqual(
    harness.ledger.rows({ runId: request.runId }).map((row) => [row.kind, row.ending]),
    [
      ["research", "finish"],
      ["title", "finish"],
      ["summary", "finish"],
    ],
  );
  assertTok(t, harness, request.runId);
});

test("a superseded run writes no title", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("untitled");
  const request = harness.runRequest(user.id, "fixture:success", {
    finalSteps: { title: true, summary: true },
  });
  // The fence fails once the answer is in: the run is retried before its
  // title step writes.
  const store = harness.store;
  const commit = store.commitTurn.bind(store);
  store.commitTurn = (req, turn) => {
    commit(req, turn);
    store.attempts.set(req.runId, 2);
  };

  t.is((await harness.agent.run(request)).outcome, "superseded");
  t.false(store.calls.some((call) => call.kind === "title" || call.kind === "finish"));
  t.true(harness.ledger.rows({ runId: request.runId }).every((row) => row.state === "closed"));
});

test("a crash copy is independent of the live ledger", (t) => {
  const ledger = new MemoryLedger();
  const id = ledger.open({
    runId: "r",
    attempt: 1,
    userId: "u",
    payer: "included",
    week: "2026-11-20",
    kind: "research",
    provider: "anthropic",
    model: "claude-fable",
    cachedInputRatio: 0.1,
    counts: { inputTokens: 10, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    openedAt: 0,
  });
  const copy = ledger.crashCopy();
  ledger.close(
    id,
    { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedTokens: 0 },
    "finish",
    1,
  );
  ledger.close(
    id,
    { inputTokens: 10, outputTokens: 99, reasoningTokens: 0, cachedTokens: 0 },
    "cancel",
    2,
  );
  t.is(ledger.runTokens("r"), 15, "a closed row is not closed again");
  t.is(copy.rows()[0]?.state, "open");
  t.is(copy.includedUsage("u", "2026-11-20"), 10, "open rows count");
});

test("K9: the step boundary alone stops a run past allowance plus overdraft when no checkpoint fires", async (t) => {
  // the default 2 s checkpoint interval: no checkpoint fires in these steps
  const harness = createLoopHarness(t, {
    env: { SESSION_WEEKLY_TOKENS: "500", SESSION_OVERDRAFT_TOKENS: "500" },
  });
  const user = harness.addUser("boundary-only");
  const at = Date.now();
  const earlier = harness.ledger.open({
    runId: "earlier",
    attempt: 1,
    userId: user.id,
    payer: "included",
    week: weekOf(at),
    kind: "research",
    provider: "vertex",
    model: "gemini-flash",
    cachedInputRatio: 1,
    counts: { ...ZERO_COUNTS, inputTokens: 100 },
    openedAt: at,
  });
  harness.ledger.close(earlier, { ...ZERO_COUNTS, inputTokens: 100 }, "finish", at);
  // the first step is billed 940: 1,040 is past the 1,000 limit
  const request = harness.runRequest(user.id, "fixture:success-with-tools");

  t.is((await harness.agent.run(request)).outcome, "complete");
  t.is(harness.store.finishes(request.runId)[0]?.summary.note, OVERDRAFT_STOP_NOTE);
  const rows = harness.ledger.rows({ runId: request.runId });
  t.deepEqual(
    rows.map((row) => [row.kind, row.ending, row.writes.length]),
    [["research", "finish", 2]],
    "one call, no checkpoint",
  );
});

/** An `AttemptMeter` over a memory ledger with a clock the test moves, and a
 * model whose stream the test feeds part by part. */
function meterWithClock(at: number, checkpointMs = 100) {
  const ledger = new MemoryLedger();
  const clock = { at };
  const meter = new AttemptMeter(
    { ledger, now: () => clock.at, checkpointMs },
    { runId: "metered", attempt: 1, userId: "u1" },
    { abortEnding: () => "cancel" },
  );
  let feed: ReadableStreamDefaultController<LanguageModelV4StreamPart> | null = null;
  const source: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("not used")),
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            feed = controller;
          },
        }),
      }),
  };
  const entry = findModel("gemini-flash") as ModelEntry;
  const model = meter.wrap(source, { entry, payer: "included", kind: "research" });
  const abort = new AbortController();
  const options: LanguageModelV4CallOptions = {
    prompt: [{ role: "user", content: [{ type: "text", text: "A question." }] }],
    abortSignal: abort.signal,
  };
  /** Starts the call; `next(part)` feeds one part and reads it through. */
  const start = async () => {
    const reader = (await model.doStream(options)).stream.getReader();
    return async (part: LanguageModelV4StreamPart) => {
      feed?.enqueue(part);
      await reader.read();
    };
  };
  return { ledger, clock, start, abort };
}

const delta = (text: string): LanguageModelV4StreamPart => ({
  type: "text-delta",
  id: "t0",
  delta: text,
});

test("K1: a checkpoint is written once checkpointMs has passed, exactly", async (t) => {
  const m = meterWithClock(1_000_000, 100);
  const next = await m.start();
  await next(delta(CHUNK));
  t.is(m.ledger.rows()[0]?.writes.length, 1, "the open write only");
  m.clock.at += 100;
  await next(delta(CHUNK));
  t.is(m.ledger.rows()[0]?.writes.length, 2, "one checkpoint");
});

test("K1: consecutive checkpoint writes of a row are at least checkpointMs apart", async (t) => {
  const m = meterWithClock(1_000_000, 100);
  const next = await m.start();
  for (let i = 0; i < 20; i += 1) {
    m.clock.at += 30;
    await next(delta(CHUNK));
  }
  const writes = m.ledger.rows()[0]?.writes ?? [];
  t.true(writes.length >= 4, `${writes.length} writes`);
  for (let i = 1; i < writes.length; i += 1) {
    t.true(writes[i]!.at - writes[i - 1]!.at >= 100, `write ${i}`);
  }
});

test("K1, K3: a call opened at Friday 00:00:00.000 UTC counts in the week that starts then", async (t) => {
  const friday = Date.UTC(2026, 10, 27);
  const m = meterWithClock(friday);
  await m.start();
  t.is(m.ledger.rows()[0]?.week, "2026-11-27");
});

test("K1, K2: a call cancelled after streaming only reasoning closes with its reasoning inside its output", async (t) => {
  const m = meterWithClock(1_000_000);
  const next = await m.start();
  await next({ type: "reasoning-start", id: "r0" });
  await next({ type: "reasoning-delta", id: "r0", delta: CHUNK.repeat(4) });
  m.abort.abort();
  const [row] = m.ledger.rows();
  t.like(row, { state: "closed", ending: "cancel" });
  t.true((row?.counts.reasoningTokens ?? 0) > 0);
  t.true((row?.counts.outputTokens ?? 0) >= (row?.counts.reasoningTokens ?? 0));
});
