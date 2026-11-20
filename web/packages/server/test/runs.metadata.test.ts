// Metadata runs: titles and context summaries on `METADATA_MODEL_ID`
// (`04-agent-runtime.md` §9).

import { usage } from "@session/db";
import { RESEARCH_TITLE_MAX_CHARS } from "@session/shared";
import test from "ava";

import { createLoopHarness } from "./runsHelpers.js";

test("a title is generated, sanitized, and its usage recorded", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("titler");

  const title = await harness.agent.metadata.generateTitle({
    userId: user.id,
    runId: "run-title",
    question: "What is a bloom filter?",
    opening: "A bloom filter is a probabilistic set.",
  });
  t.truthy(title);
  t.true((title ?? "").length <= RESEARCH_TITLE_MAX_CHARS);
  t.true(usage.dailyTotals(harness.db, user.id).inputTokens > 0);
});

test("a context summary is generated, and empty text is not sent", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("summarizer");

  t.is(await harness.agent.metadata.summarize({ text: "  ", userId: user.id }), null);
  t.is(usage.dailyTotals(harness.db, user.id).inputTokens, 0, "nothing was sent");

  const summary = await harness.agent.metadata.summarize({
    text: "user: What is a bloom filter?\n\nassistant: A probabilistic set.",
    userId: user.id,
  });
  t.truthy(summary);
});
