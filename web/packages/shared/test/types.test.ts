import test from "ava";

import { sessionEventSchema } from "../src/schemas/events.js";
import {
  researchHighlightAnchorSchema,
  researchNodeSchema,
  researchNodeStatusSchema,
  researchNodeContentSchema,
} from "../src/schemas/research.js";
import { isTurn, turnSchema } from "../src/schemas/turn.js";
import { DEFAULT_USER_SETTINGS, userSettingsSchema } from "../src/types/account.js";

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
  groupId: "w1",
  type: "exchange",
  message: { text: "why" },
  agent: { adapter: "gemini", model: "gemini-flash", effort: null },
  run: { status: "running", sessionReady: false, attempt: 1 },
  createdAt: 1,
  highlights: [],
};

test("the status enum is the desktop's lifecycle plus the web's interrupted", (t) => {
  t.deepEqual(researchNodeStatusSchema.options, [
    "queued",
    "starting",
    "running",
    "complete",
    "failed",
    "cancelled",
    "interrupted",
  ]);
});

test("a minimal exchange parses", (t) => {
  t.deepEqual(researchNodeSchema.parse(node), node);
});

test("an exchange without groupId, agent or run is rejected", (t) => {
  for (const missing of ["groupId", "agent", "run"]) {
    const partial: Record<string, unknown> = { ...node };
    delete partial[missing];
    t.false(researchNodeSchema.safeParse(partial).success, `${missing} is required`);
  }
});

test("each node type parses with its own body", (t) => {
  const base = { id: "n2", treeId: "t1", groupId: "w1", createdAt: 1, highlights: [] };
  t.true(
    researchNodeSchema.safeParse({
      ...base,
      type: "post",
      message: { text: "https://example.com" },
      format: "link",
      followUpAgent: { adapter: "gemini", model: "gemini-flash" },
    }).success,
  );
  t.true(researchNodeSchema.safeParse({ ...base, type: "document", source: "authored" }).success);
  t.false(
    researchNodeSchema.safeParse({ ...base, type: "post", message: { text: "x" } }).success,
    "a post needs a format and a follow-up agent",
  );
});

test("fields the wire does not define are stripped", (t) => {
  const parsed = researchNodeSchema.parse({
    ...node,
    worktreeDir: "/tmp",
    agentId: "a1",
    paneId: "p1",
  });
  for (const dropped of ["worktreeDir", "agentId", "paneId"]) {
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

test("validates Turn objects directly against the canonical schema definition", (t) => {
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

test("the event envelope keeps its payload", (t) => {
  const event = sessionEventSchema.parse({
    type: "research.turn.delta",
    payload: { nodeId: "n1", seq: 4, turnId: "turn-1", text: "…" },
    timestamp: 1,
  });
  t.is(event.payload.seq, 4);
  t.is(event.paneId, undefined);
});

test("a stored settings blob carrying a removed key still parses", (t) => {
  // `showShortcutHints` was dropped with the sidebar's Cmd-held badges. Rows
  // written before that are still in `user_preferences.settings_json` and in
  // every browser's `session.settings.v2`, and the loader reads them through
  // this schema — so a key no longer defined by the shape has to be ignored, not
  // rejected.
  const stored = { ...DEFAULT_USER_SETTINGS, showShortcutHints: true };
  const parsed = userSettingsSchema.safeParse(stored);
  t.true(parsed.success, "an unknown key does not fail the whole object");
  t.deepEqual(parsed.data, DEFAULT_USER_SETTINGS, "and is dropped rather than carried");
  t.false("showShortcutHints" in DEFAULT_USER_SETTINGS);
});
