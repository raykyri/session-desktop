import test from "ava";

import { sessionEventSchema } from "../src/types/events.js";
import { journalEntrySchema } from "../src/types/journal.js";
import {
  researchHighlightAnchorSchema,
  researchNodeSchema,
  researchNodeStatusSchema,
  researchNodeContentSchema,
} from "../src/types/research.js";
import { isTurn, turnSchema } from "../src/types/turn.js";

const anchor = {
  version: 1,
  projection: "answer-v1",
  responseRevision: "a".repeat(64),
  start: 0,
  end: 5,
  exact: "hello",
  prefix: "",
  suffix: "",
};

const node = {
  id: "n1",
  treeId: "t1",
  workspaceId: "w1",
  prompt: "why",
  documentIds: [],
  model: "gemini-flash",
  status: "running",
  attempt: 1,
  createdAt: 1,
  highlights: [],
};

test("the status enum is the web's lifecycle, not the desktop's", (t) => {
  t.deepEqual(researchNodeStatusSchema.options, [
    "queued",
    "running",
    "complete",
    "failed",
    "cancelled",
    "interrupted",
  ]);
});

test("a minimal node parses", (t) => {
  t.deepEqual(researchNodeSchema.parse(node), node);
});

test("a node without workspaceId, model, attempt or documentIds is rejected", (t) => {
  for (const missing of ["workspaceId", "model", "attempt", "documentIds"]) {
    const partial: Record<string, unknown> = { ...node };
    delete partial[missing];
    t.false(researchNodeSchema.safeParse(partial).success, `${missing} is required`);
  }
});

test("the desktop's dropped node fields are not carried on the wire", (t) => {
  const parsed = researchNodeSchema.parse({
    ...node,
    groupId: "g1",
    worktreeDir: "/tmp",
    adapter: "claude",
    agentId: "a1",
    paneId: "p1",
    effort: "high",
  });
  for (const dropped of ["groupId", "worktreeDir", "adapter", "agentId", "paneId", "effort"]) {
    t.false(dropped in parsed, `${dropped} is stripped`);
  }
});

test("a highlight anchor is pinned to version 1 and the answer-v1 projection", (t) => {
  t.true(researchHighlightAnchorSchema.safeParse(anchor).success);
  t.false(researchHighlightAnchorSchema.safeParse({ ...anchor, version: 2 }).success);
  t.false(researchHighlightAnchorSchema.safeParse({ ...anchor, projection: "raw" }).success);
});

test("anchor offsets are whole, non-negative code-unit positions", (t) => {
  for (const offsets of [
    { start: -1, end: 4 },
    { start: 0, end: -5 },
    { start: 0.5, end: 5.5 },
    { start: 0, end: 5.5 },
  ]) {
    t.false(
      researchHighlightAnchorSchema.safeParse({ ...anchor, ...offsets }).success,
      JSON.stringify(offsets),
    );
  }
  // The pair `validateHighlightAnchor` cannot catch on its own: every one of
  // its checks passes, because `end - start` still equals `exact.length`.
  t.false(
    researchHighlightAnchorSchema.safeParse({ ...anchor, start: -10, end: -5 }).success,
    "a negative pair of the right width",
  );
  t.true(researchHighlightAnchorSchema.safeParse({ ...anchor, start: 0, end: 5 }).success);
});

test("a turn round-trips fields this build does not know", (t) => {
  // The canonical JSON of a turn list is the response revision's preimage, so
  // a schema that stripped an unrecognized field would change the hash of a
  // snapshot it merely read back.
  const parsed = turnSchema.parse({
    id: "turn-1",
    agentId: "n1",
    role: "assistant",
    sourceIndex: 0,
    blocks: [{ type: "text", text: "answer", providerMetadata: { signature: "abc" } }],
    futureField: 7,
  });
  t.is((parsed as Record<string, unknown>).futureField, 7);
  t.deepEqual((parsed.blocks[0] as { providerMetadata?: unknown }).providerMetadata, {
    signature: "abc",
  });
});

test("isTurn is the schema, not a second opinion about it", (t) => {
  const turn = {
    id: "turn-1",
    agentId: "n1",
    role: "assistant",
    sourceIndex: 0,
    blocks: [{ type: "text", text: "answer" }],
  };
  t.true(isTurn(turn));
  t.false(isTurn({ ...turn, sourceIndex: undefined }), "sourceIndex is required");
  t.false(isTurn({ ...turn, status: "cancelled" }), "status is a closed enum");
  t.false(isTurn({ ...turn, blocks: [{ type: "thinking" }] }), "blocks are the four kinds");
  t.false(isTurn(null));
  t.false(isTurn([turn]));
});

test("node content carries the live-stream fields", (t) => {
  const content = researchNodeContentSchema.parse({
    node,
    turns: [],
    children: [],
    inFlightText: "partial",
    seq: 12,
    queuePosition: 3,
  });
  t.is(content.inFlightText, "partial");
  t.is(content.seq, 12);
  t.is(content.queuePosition, 3);
});

test("a turn's blocks are the four durable kinds", (t) => {
  const turn = turnSchema.parse({
    id: "turn-1",
    agentId: "n1",
    role: "assistant",
    sourceIndex: 0,
    blocks: [
      { type: "text", text: "answer" },
      { type: "toolUse", id: "call-1", name: "web_search", input: { query: "q" } },
      { type: "toolResult", toolUseId: "call-1", content: ["result"], isError: false },
      { type: "raw", value: { unknown: true } },
    ],
  });
  t.deepEqual(
    turn.blocks.map((block) => block.type),
    ["text", "toolUse", "toolResult", "raw"],
  );
});

test("an unknown block type is rejected", (t) => {
  t.false(
    turnSchema.safeParse({
      id: "turn-1",
      agentId: "n1",
      role: "assistant",
      sourceIndex: 0,
      blocks: [{ type: "thinking", text: "…" }],
    }).success,
  );
});

test("journal entries are links and tweets only", (t) => {
  t.true(
    journalEntrySchema.safeParse({
      id: "j1",
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "link",
      url: "https://example.com",
    }).success,
  );
  t.false(
    journalEntrySchema.safeParse({
      id: "j2",
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "note",
      text: "…",
    }).success,
  );
});

test("the event envelope has no paneId or agentId", (t) => {
  const event = sessionEventSchema.parse({
    type: "research.turn.delta",
    payload: { nodeId: "n1", seq: 4, turnId: "turn-1", text: "…" },
    timestamp: 1,
    paneId: "p1",
    agentId: "a1",
  });
  t.false("paneId" in event);
  t.false("agentId" in event);
  t.is(event.payload.seq, 4);
});
