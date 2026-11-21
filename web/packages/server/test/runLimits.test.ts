// Per-run limits and what counts (`03-agents-and-research.md` L1, L2, K2),
// over the run records: the 21st queued ask is a recorded `queue_full`
// refusal, a look-up runs under its own tool caps, and cached input counts
// at the model's ratio.

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { QUEUED_RUNS_MAX } from "@session/mutators";
import test from "ava";

import { registerFixture, setFixtureScenario } from "../src/runs/fixtureProvider.js";

import { MODEL, newId, runsWorld } from "./recordRuns.js";

test.serial(
  "L1: the 21st queued ask is refused queue_full and recorded; a resend replays the answer and the next seq follows it",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const ask = () => ({ id: newId(), space: w.open, kind: "ask", q: "Why?", ...MODEL });
    for (let k = 0; k < QUEUED_RUNS_MAX; k += 1) await w.mona.ok("threads.create", ask());
    await w.mona.register();
    const e = w.mona.envelope("threads.create", ask());
    const first = await w.mona.send([e]);
    t.like(first.answers[0], {
      ok: false,
      error: { code: "PRECONDITION_FAILED", reason: "queue_full" },
    });
    // recorded: the same envelope again answers as before and runs nothing
    const runs = w.sync.store.sqlite
      .prepare("SELECT count(*) AS n FROM records WHERE kind = 'run'")
      .get() as { n: number };
    const again = await w.mona.send([e]);
    t.like(again.answers[0], {
      ok: false,
      replay: true,
      error: { code: "PRECONDITION_FAILED", reason: "queue_full" },
    });
    t.deepEqual(
      w.sync.store.sqlite.prepare("SELECT count(*) AS n FROM records WHERE kind = 'run'").get(),
      runs,
    );
    // the refusal used its seq: the next envelope carries the one after it
    t.is(w.sync.store.client(w.mona.clientId)?.last, e.seq);
    const next = w.mona.envelope("threads.create", {
      id: newId(),
      space: w.open,
      kind: "post",
      q: "A post is never blocked.",
    });
    t.is(next.seq, e.seq + 1);
    t.like((await w.mona.send([next])).answers[0], { ok: true });
    // a member under the limit is not refused
    t.like(await w.mel.write("threads.create", ask()), { ok: true });
  },
);

const searchStep = (index: number): { parts: LanguageModelV4StreamPart[] } => ({
  parts: [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call-search-${index}`,
      toolName: "web_search",
      input: JSON.stringify({ query: `query ${index}` }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
    },
  ],
});

registerFixture({
  scenario: "search-forever",
  steps: Array.from({ length: 10 }, (_, index) => searchStep(index)),
});

test.serial("L2: a look-up that keeps calling tools stops at 2 searches and 4 steps", async (t) => {
  const w = await runsWorld(t);
  const { thread, run } = await w.ask(w.mona, w.open, "fixture:success");
  await w.settled(run);
  setFixtureScenario(() => "search-forever");
  const look = (await w.mel.ok("research.forkNode", {
    id: newId(),
    thread,
    parent: "r",
    kind: "lookup",
    look: "probabilistic set",
    quote: "A Bloom filter is a probabilistic set.",
    b: 0,
    ...MODEL,
  })) as { run: string };
  await w.settled(look.run);
  t.is(
    w.network.calls.filter((c) => c.url.startsWith("https://api.parallel.ai/")).length,
    2,
    "the third search is refused by the budget",
  );
  t.is(w.rows(look.run).filter((r) => r.kind === "research").length, 4, "4 steps, 4 calls");
});

test.serial(
  "K2: cached input counts at the model's ratio; the ledger keeps the raw counts and the counted total",
  async (t) => {
    const w = await runsWorld(t);
    const { run } = await w.ask(w.mona, w.open, "fixture:success-with-tools");
    await w.settled(run);
    const last = w
      .rows(run)
      .filter((r) => r.kind === "research")
      .at(-1);
    // 2,100 input of which 100 cached, at the registry's 0.1, and 120 output
    t.like(last, { input_tokens: 2_100, cached_tokens: 100, output_tokens: 120 });
    t.is(last?.counted, 2_000 + 10 + 120);
  },
);
