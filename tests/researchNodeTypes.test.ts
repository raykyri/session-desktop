import assert from "node:assert/strict";
import test from "node:test";
import { followUpLaunch, nodeMessage, nodeType, recapEligible } from "../src/lib/researchNodeTypes";
import { canFollowUpFrom } from "../src/lib/researchThreads";
import type { ResearchNode } from "../src/types";

function node(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "node",
    treeId: "tree",
    prompt: "What changed?",
    adapter: "claude",
    groupId: "ws",
    worktreeDir: "/ws",
    status: "complete",
    createdAt: 0,
    highlights: [],
    ...overrides,
  };
}

test("node types follow the stored kind and origin", () => {
  const cases: [Partial<ResearchNode>, ReturnType<typeof nodeType>, "fork" | "context", boolean][] = [
    [{}, "exchange", "fork", true],
    [{ kind: "run" }, "exchange", "fork", true],
    [{ kind: "document", origin: "imported" }, "document", "context", true],
    [{ kind: "document" }, "document", "context", false],
    [{ kind: "conversation", origin: "terminalExport" }, "document", "context", false],
    [{ kind: "note" }, "post", "context", false],
  ];
  for (const [overrides, type, launch, recap] of cases) {
    const value = node(overrides);
    assert.equal(nodeType(value), type, JSON.stringify(overrides));
    assert.equal(followUpLaunch(value), launch, JSON.stringify(overrides));
    assert.equal(recapEligible(value), recap, JSON.stringify(overrides));
  }
});

test("only a document without a question has no user message", () => {
  const attachments = [{ kind: "tweet" }] as unknown as ResearchNode["attachments"];
  assert.deepEqual(nodeMessage(node({ attachments })), { text: "What changed?", attachments });
  assert.deepEqual(nodeMessage(node({ kind: "note" })), { text: "What changed?", attachments: [] });
  assert.deepEqual(nodeMessage(node({ kind: "document", origin: "imported" })), {
    text: "What changed?",
    attachments: [],
  });
  assert.equal(nodeMessage(node({ kind: "document" })), null);
  assert.equal(nodeMessage(node({ kind: "conversation", origin: "terminalExport" })), null);
});

test("follow-ups that fork need the session checkpoint; context launches do not", () => {
  assert.equal(canFollowUpFrom(node({ nativeSessionId: null })), false);
  assert.equal(canFollowUpFrom(node({ nativeSessionId: "session" })), true);
  assert.equal(canFollowUpFrom(node({ kind: "document", origin: "imported" })), true);
  assert.equal(canFollowUpFrom(node({ kind: "note" })), true);
  assert.equal(canFollowUpFrom(node({ kind: "note", status: "running" })), false);
});
