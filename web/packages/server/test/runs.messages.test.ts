// The canonical message store: forks, the context budget, and documents as
// parts (`04-agent-runtime.md` §4, §8).

import {
  documents as documentsRepo,
  messages as messagesRepo,
  nodes as nodesRepo,
  snapshots as snapshotsRepo,
  trees as treesRepo,
} from "@session/db";
import { findModel } from "@session/shared";
import type { ModelMessage } from "ai";
import test from "ava";

import {
  ELIDED_TOOL_RESULT,
  ancestorContext,
  compactContext,
  documentParts,
  estimateTokens,
  messagesFromCommittedTurns,
  stripForeignReasoning,
} from "../src/runs/messages.js";
import { ToolBudget, createToolCaches } from "../src/runs/tools/context.js";
import type { RunToolContext } from "../src/runs/tools/context.js";

import { answerTurn, createHarness } from "./helpers.js";

function toolContext(harness: ReturnType<typeof createHarness>, userId: string): RunToolContext {
  return {
    config: harness.config,
    db: harness.db,
    userId,
    nodeId: null,
    logger: harness.logger,
    fetch: globalThis.fetch,
    budget: new ToolBudget(),
    caches: createToolCaches(),
    recordUsage: () => undefined,
  };
}

const REASONING_MESSAGE: ModelMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "private", providerOptions: { anthropic: { signature: "sig" } } },
    { type: "text", text: "The answer." },
  ],
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
};

test("a same-model fork keeps reasoning and a cross-model fork drops it", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("forker");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = treesRepo.admitRoot(harness.db, user.id, {
    workspaceId: workspace.id,
    prompt: "root",
    model: "claude-fable",
  });
  const rootId = detail.tree.rootNodeId;
  snapshotsRepo.commit(harness.db, user.id, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "The answer.")],
    outcome: { status: "complete" },
  });
  messagesRepo.appendMessages(harness.db, user.id, rootId, [
    { message: { role: "user", content: "root" }, model: null },
    { message: REASONING_MESSAGE, model: "claude-fable" },
  ]);

  const sameModel = nodesRepo.admitChild(harness.db, user.id, {
    parentNodeId: rootId,
    prompt: "follow-up",
    model: "claude-fable",
  });
  const kept = ancestorContext(harness.db, user.id, sameModel);
  const keptParts = kept[1]?.message.content as { type: string }[];
  t.true(
    keptParts.some((part) => part.type === "reasoning"),
    "same model keeps its thinking",
  );

  const otherModel = nodesRepo.admitChild(harness.db, user.id, {
    parentNodeId: rootId,
    prompt: "follow-up elsewhere",
    model: "gemini-flash",
    inline: true,
  });
  const dropped = ancestorContext(harness.db, user.id, otherModel);
  const droppedMessage = dropped[1]?.message as ModelMessage & { providerOptions?: unknown };
  const droppedParts = droppedMessage.content as { type: string; providerOptions?: unknown }[];
  t.false(
    droppedParts.some((part) => part.type === "reasoning"),
    "a cross-model fork drops foreign reasoning",
  );
  t.is(droppedMessage.providerOptions, undefined, "and the provider metadata with it");
  t.deepEqual(droppedParts, [{ type: "text", text: "The answer." }]);
});

test("stripForeignReasoning leaves a plain message alone", (t) => {
  const plain: ModelMessage = { role: "user", content: "a question" };
  t.deepEqual(stripForeignReasoning(plain), plain);
});

test("the context budget elides old tool results before it summarizes", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("verbose");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  // Real nodes, because the summary cache is keyed on the node it covers.
  const detail = treesRepo.admitRoot(harness.db, user.id, {
    workspaceId: workspace.id,
    prompt: "root",
    model: "gemini-flash",
  });
  const ids: string[] = [detail.tree.rootNodeId];
  for (let depth = 0; depth < 2; depth += 1) {
    const parentId = ids[depth] ?? "";
    snapshotsRepo.commit(harness.db, user.id, {
      nodeId: parentId,
      turns: [answerTurn(parentId, "an answer")],
      outcome: { status: "complete" },
    });
    ids.push(
      nodesRepo.admitChild(harness.db, user.id, { parentNodeId: parentId, prompt: "more" }).id,
    );
  }
  const [first = "", , third = ""] = ids;
  const path = ids.flatMap((nodeId) => [
    {
      nodeId,
      model: null,
      message: { role: "user", content: `question ${nodeId}` } as ModelMessage,
    },
    {
      nodeId,
      model: "gemini-flash",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `answer ${nodeId} ${"x".repeat(200)}` }],
      } as ModelMessage,
    },
    {
      nodeId,
      model: null,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `${nodeId}-c`,
            toolName: "web_search",
            output: { type: "json", value: { page: "y".repeat(4_000) } },
          },
        ],
      } as ModelMessage,
    },
  ]);

  const untouched = await compactContext(harness.db, user.id, path, { budgetTokens: 1_000_000 });
  t.false(untouched.elidedToolResults);
  t.is(untouched.summarizedThrough, null);

  const elided = await compactContext(harness.db, user.id, path, { budgetTokens: 900 });
  t.true(elided.elidedToolResults);
  const serialized = JSON.stringify(elided.messages);
  t.true(serialized.includes(ELIDED_TOOL_RESULT), "old tool results become a placeholder");
  t.is(
    (serialized.match(new RegExp(ELIDED_TOOL_RESULT.replace(/[[\]]/g, "\\$&"), "g")) ?? []).length,
    1,
    "only the nodes beyond the last two are elided",
  );
  t.true(elided.estimatedTokens < untouched.estimatedTokens);

  // Still over budget, and a summarizer is available: the oldest node collapses.
  const summarized = await compactContext(harness.db, user.id, path, {
    budgetTokens: 100,
    summarize: () => Promise.resolve("Earlier: the thread established the basics."),
  });
  t.is(summarized.summarizedThrough, first);
  t.is(summarized.messages[0]?.role, "user");
  t.regex(JSON.stringify(summarized.messages[0]?.content), /Summary of the earlier conversation/);
  t.false(JSON.stringify(summarized.messages).includes(`question ${first}`));
  t.true(JSON.stringify(summarized.messages).includes(`question ${third}`));

  // The summary is cached on the node it covers, so the second call is free.
  let calls = 0;
  const second = await compactContext(harness.db, user.id, path, {
    budgetTokens: 100,
    summarize: () => {
      calls += 1;
      return Promise.resolve("a second summary");
    },
  });
  t.is(calls, 0, "the cached summary is reused");
  t.regex(JSON.stringify(second.messages[0]?.content), /established the basics/);
});

test("documents become file parts for models that take them and text for those that do not", (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("attacher");
  const ctx = toolContext(harness, user.id);
  const pdf = {
    id: "doc-1",
    workspaceId: "w",
    name: "paper.pdf",
    mime: "application/pdf",
    byteSize: 3,
    sha256: "s",
    pageCount: 1,
    extractionStatus: "ok" as const,
    createdAt: 0,
  };
  const bytes = new Uint8Array([1, 2, 3]);

  const gemini = findModel("gemini-flash");
  const deepseek = findModel("deepseek-flash");
  t.truthy(gemini);
  t.truthy(deepseek);
  if (!gemini || !deepseek) {
    return;
  }

  const fileParts = documentParts(ctx, gemini, pdf, bytes);
  t.is(fileParts[0]?.type, "file");
  t.is(fileParts[0]?.type === "file" ? fileParts[0].mediaType : null, "application/pdf");

  // DeepSeek has no file input: the extracted text is inlined instead.
  const textParts = documentParts(ctx, deepseek, pdf, bytes);
  t.is(textParts[0]?.type, "text");
  t.regex(
    textParts[0]?.type === "text" ? textParts[0].text : "",
    /no text could be extracted/,
    "an unextracted document says so rather than going silently missing",
  );

  const image = { ...pdf, id: "doc-2", name: "chart.png", mime: "image/png" };
  t.is(documentParts(ctx, gemini, image, bytes)[0]?.type, "image");
  t.is(
    documentParts(ctx, deepseek, image, bytes)[0]?.type,
    "text",
    "a model without image input is told what it is missing",
  );
});

test("a long attached document is inlined up to the cap and then handed to document_read", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("bigdoc");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const document = documentsRepo.create(harness.db, user.id, {
    workspaceId: workspace.id,
    name: "long.txt",
    mime: "text/plain",
    byteSize: 1,
    sha256: "long",
    storagePath: "/tmp/long.txt",
  });
  documentsRepo.setExtraction(harness.db, user.id, document.id, {
    status: "ok",
    pages: ["word ".repeat(20_000)],
  });
  const deepseek = findModel("deepseek-flash");
  t.truthy(deepseek);
  if (!deepseek) {
    return;
  }
  const parts = documentParts(toolContext(harness, user.id), deepseek, document, null);
  const text = parts[0]?.type === "text" ? parts[0].text : "";
  t.regex(text, /document_read\(\{ documentId: "/);
  t.true(text.length < 100_000);
});

test("committed turns convert back into the messages a resume replays", (t) => {
  const messages = messagesFromCommittedTurns([
    {
      id: "n-assistant-0",
      agentId: "n",
      role: "assistant",
      sourceIndex: 0,
      blocks: [
        { type: "text", text: "Searching." },
        { type: "toolUse", id: "c1", name: "web_search", input: { query: "q" } },
      ],
    },
    {
      id: "n-user-0",
      agentId: "n",
      role: "user",
      sourceIndex: 1,
      blocks: [{ type: "toolResult", toolUseId: "c1", content: { results: [] }, isError: false }],
    },
  ]);
  t.is(messages.length, 2);
  t.is(messages[0]?.role, "assistant");
  t.is(messages[1]?.role, "tool");
  const result = (messages[1]?.content as { toolName: string; output: { type: string } }[])[0];
  t.is(result?.toolName, "web_search", "the result is paired with the call that made it");
  t.is(result?.output.type, "json");
  t.true(estimateTokens(messages) > 0);
});
