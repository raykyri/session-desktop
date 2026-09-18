// Stream parts to durable turns (`04-agent-runtime.md` §3, §6.2).

import type { Turn } from "@session/shared";
import type { TextStreamPart, ToolSet } from "ai";
import test from "ava";

import { TurnMapper } from "../src/runs/mapper.js";

const FINISH_STEP = {
  type: "finish-step",
  response: { id: "r", modelId: "m", timestamp: new Date(0) },
  usage: {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  },
  performance: {},
  finishReason: "stop",
  rawFinishReason: "stop",
  providerMetadata: undefined,
} as unknown as TextStreamPart<ToolSet>;

function finishStepWith(providerMetadata: unknown): TextStreamPart<ToolSet> {
  return { ...(FINISH_STEP as object), providerMetadata } as TextStreamPart<ToolSet>;
}

function collect(parts: TextStreamPart<ToolSet>[], options = {}) {
  const committed: Turn[] = [];
  const deltas: { turnId: string; text: string }[] = [];
  const thinking: boolean[] = [];
  const mapper = new TurnMapper(
    { runId: "node-1", agentId: "node-1", now: () => 1_700_000_000_000, ...options },
    {
      onTurnCommitted: (turn) => committed.push(turn),
      onTextDelta: (turnId, text) => deltas.push({ turnId, text }),
      onThinking: (active) => thinking.push(active),
    },
  );
  for (const part of parts) {
    mapper.handle(part);
  }
  mapper.finish();
  return { committed, deltas, thinking, mapper };
}

test("a tool step becomes an assistant turn and a user turn of results", (t) => {
  const { committed, deltas, thinking } = collect([
    { type: "reasoning-start", id: "r0" },
    { type: "reasoning-delta", id: "r0", text: "thinking" },
    { type: "reasoning-end", id: "r0" },
    { type: "text-delta", id: "t0", text: "Looking " },
    { type: "text-delta", id: "t0", text: "this up." },
    {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "web_search",
      input: { query: "bloom filter" },
    } as unknown as TextStreamPart<ToolSet>,
    {
      type: "tool-result",
      toolCallId: "c1",
      toolName: "web_search",
      input: { query: "bloom filter" },
      output: { results: [{ url: "https://example.com" }] },
    } as unknown as TextStreamPart<ToolSet>,
    FINISH_STEP,
    { type: "text-delta", id: "t1", text: "The answer." },
    FINISH_STEP,
  ]);

  t.deepEqual(
    committed.map((turn) => turn.id),
    ["node-1-assistant-0", "node-1-user-0", "node-1-assistant-1"],
  );
  t.deepEqual(
    committed.map((turn) => turn.role),
    ["assistant", "user", "assistant"],
  );
  t.deepEqual(
    committed.map((turn) => turn.sourceIndex),
    [0, 1, 2],
  );
  t.deepEqual(committed[0]?.blocks, [
    { type: "text", text: "Looking this up." },
    { type: "toolUse", id: "c1", name: "web_search", input: { query: "bloom filter" } },
  ]);
  t.deepEqual(committed[1]?.blocks, [
    {
      type: "toolResult",
      toolUseId: "c1",
      content: { results: [{ url: "https://example.com" }] },
      isError: false,
    },
  ]);
  // Reasoning is an indicator, never a block.
  t.deepEqual(thinking, [true, false]);
  t.false(
    committed.some((turn) => turn.blocks.some((block) => block.type === "raw")),
    "reasoning never reaches the durable format",
  );
  t.deepEqual(deltas, [
    { turnId: "node-1-assistant-0", text: "Looking " },
    { turnId: "node-1-assistant-0", text: "this up." },
    { turnId: "node-1-assistant-1", text: "The answer." },
  ]);
});

test("a tool error is a failed tool result, not a lost step", (t) => {
  const { committed } = collect([
    {
      type: "tool-call",
      toolCallId: "c9",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
    } as unknown as TextStreamPart<ToolSet>,
    {
      type: "tool-error",
      toolCallId: "c9",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
      error: new Error("could not read it"),
    } as unknown as TextStreamPart<ToolSet>,
    FINISH_STEP,
  ]);
  const result = committed[1]?.blocks[0];
  t.is(result?.type, "toolResult");
  t.true(result?.type === "toolResult" && result.isError);
  t.deepEqual(result?.type === "toolResult" ? result.content : null, {
    error: "could not read it",
  });
});

test("Google grounding becomes a synthetic google_search exchange", (t) => {
  const { committed } = collect([
    { type: "text-delta", id: "t0", text: "A grounded answer." },
    finishStepWith({
      google: {
        groundingMetadata: {
          webSearchQueries: ["kessler syndrome"],
          groundingChunks: [
            { web: { uri: "https://redirect.example/abc", title: "nasa.gov" } },
            { web: {} },
          ],
          searchEntryPoint: { renderedContent: "<div>suggestions</div>" },
        },
      },
    }),
  ]);
  const use = committed[0]?.blocks.find((block) => block.type === "toolUse");
  t.is(use?.type === "toolUse" ? use.name : null, "google_search");
  t.deepEqual(use?.type === "toolUse" ? use.input : null, { queries: ["kessler syndrome"] });
  const result = committed[1]?.blocks[0];
  t.deepEqual(result?.type === "toolResult" ? result.content : null, {
    results: [{ url: "https://redirect.example/abc", title: "nasa.gov" }],
    searchEntryPoint: "<div>suggestions</div>",
  });
});

test("a resumed attempt continues the turn numbering", (t) => {
  const { committed } = collect(
    [{ type: "text-delta", id: "t0", text: "Continuing." }, FINISH_STEP],
    { startStep: 2, startSourceIndex: 4 },
  );
  t.is(committed[0]?.id, "node-1-assistant-2");
  t.is(committed[0]?.sourceIndex, 4);
});

test("an interrupted stream keeps its partial text as a turn", (t) => {
  const { committed, mapper } = collect([
    { type: "text-delta", id: "t0", text: "Half an " },
    { type: "text-delta", id: "t0", text: "answer" },
  ]);
  t.is(committed.length, 1, "finish() closes the open step");
  t.deepEqual(committed[0]?.blocks, [{ type: "text", text: "Half an answer" }]);
  t.is(mapper.inFlightText, "", "nothing is left in flight afterwards");
});

test("the in-flight turn is what a checkpoint writes", (t) => {
  const mapper = new TurnMapper({ runId: "n", agentId: "n" });
  t.is(mapper.inFlightTurn(), null);
  mapper.handle({ type: "text-delta", id: "t0", text: "partial" });
  t.is(mapper.inFlightText, "partial");
  t.deepEqual(mapper.inFlightTurn()?.blocks, [{ type: "text", text: "partial" }]);
  t.is(mapper.inFlightTurn()?.id, "n-assistant-0");
});
