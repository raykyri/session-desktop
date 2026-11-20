// Metadata runs: titles, summary lines and context summaries on
// `METADATA_MODEL_ID` (`04-agent-runtime.md` §9), billed through the run's
// ledger meter (`03` E2, K2).

import { METADATA_MODEL_ID, RESEARCH_TITLE_MAX_CHARS } from "@session/shared";
import test from "ava";

import type { ModelWrap } from "../src/runs/metadata.js";
import { AttemptMeter } from "../src/runs/meter.js";

import type { LoopHarness } from "./runsHelpers.js";
import { createLoopHarness } from "./runsHelpers.js";

/** A meter over the harness ledger, as a run's would be. */
function meterFor(harness: LoopHarness, userId: string, runId: string): ModelWrap {
  const meter = new AttemptMeter(
    { ledger: harness.ledger, now: Date.now, checkpointMs: 2_000 },
    { runId, attempt: 1, userId },
    { abortEnding: () => "cancel" },
  );
  return (model, entry, kind) => meter.wrap(model, { entry, payer: "included", kind });
}

test("a title is generated, sanitized, and its call billed to the run", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("titler");

  const title = await harness.agent.metadata.generateTitle({
    userId: user.id,
    runId: "run-title",
    question: "What is a bloom filter?",
    opening: "A bloom filter is a probabilistic set.",
    wrap: meterFor(harness, user.id, "run-title"),
  });
  t.truthy(title);
  t.true((title ?? "").length <= RESEARCH_TITLE_MAX_CHARS);
  const [row] = harness.ledger.rows({ runId: "run-title" });
  t.like(row, {
    kind: "title",
    model: METADATA_MODEL_ID,
    payer: "included",
    state: "closed",
    ending: "finish",
  });
  // The fixture's metadata answer reports 400 input and 50 output tokens.
  t.like(row?.counts, { inputTokens: 400, outputTokens: 50 });
});

test("a summary line is generated and billed", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("liner");

  const line = await harness.agent.metadata.generateSummaryLine({
    userId: user.id,
    runId: "run-line",
    question: "What is a bloom filter?",
    answer: "A bloom filter is a probabilistic set.",
    wrap: meterFor(harness, user.id, "run-line"),
  });
  t.truthy(line);
  t.like(harness.ledger.rows({ runId: "run-line" })[0], { kind: "summary", state: "closed" });
});

test("a context summary is generated, and empty text is not sent", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("summarizer");

  t.is(await harness.agent.metadata.summarize({ text: "  ", userId: user.id }), null);
  t.deepEqual(harness.ledger.rows(), [], "nothing was sent");

  const summary = await harness.agent.metadata.summarize({
    text: "user: What is a bloom filter?\n\nassistant: A probabilistic set.",
    userId: user.id,
    wrap: meterFor(harness, user.id, "run-context"),
  });
  t.truthy(summary);
  t.like(harness.ledger.rows({ runId: "run-context" })[0], { kind: "context", state: "closed" });
});
