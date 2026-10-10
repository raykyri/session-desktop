import assert from "node:assert/strict";
import test from "node:test";
import { followUpLaunch, nodeMessage, nodeType, recapEligible } from "../src/lib/researchNodeTypes";
import { canFollowUpFrom } from "../src/lib/researchThreads";
import type { ResearchMessageAttachment, ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

function node(overrides: NodeFixture = {}): ResearchNode {
  return researchNode({
    id: "node",
    treeId: "tree",
    prompt: "What changed?",
    adapter: "claude",
    groupId: "ws",
    status: "complete",
    createdAt: 0,
    highlights: [],
    ...overrides,
  });
}

test("follow-up launch and recaps follow the node type and document source", () => {
  const cases: [NodeFixture, ReturnType<typeof nodeType>, "fork" | "context", boolean][] = [
    [{}, "exchange", "fork", true],
    [{ type: "exchange" }, "exchange", "fork", true],
    [{ type: "document", source: "imported" }, "document", "context", true],
    [{ type: "document" }, "document", "context", false],
    [{ type: "document", source: "transcript" }, "document", "context", false],
    [{ type: "post" }, "post", "context", false],
  ];
  for (const [overrides, type, launch, recap] of cases) {
    const value = node(overrides);
    assert.equal(nodeType(value), type, JSON.stringify(overrides));
    assert.equal(followUpLaunch(value), launch, JSON.stringify(overrides));
    assert.equal(recapEligible(value), recap, JSON.stringify(overrides));
  }
});

test("only a document without a question has no user message", () => {
  const attachments = [{ kind: "tweet" }] as unknown as ResearchMessageAttachment[];
  assert.deepEqual(nodeMessage(node({ attachments })), { text: "What changed?", attachments });
  assert.deepEqual(nodeMessage(node({ type: "post" })), { text: "What changed?", attachments: [] });
  assert.deepEqual(nodeMessage(node({ type: "document", source: "imported" })), {
    text: "What changed?",
    attachments: [],
  });
  assert.equal(nodeMessage(node({ type: "document" })), null);
  assert.equal(nodeMessage(node({ type: "document", source: "transcript" })), null);
});

test("follow-ups that fork need the session checkpoint; context launches do not", () => {
  assert.equal(canFollowUpFrom(node({ sessionReady: false })), false);
  assert.equal(canFollowUpFrom(node({ sessionReady: true })), true);
  assert.equal(canFollowUpFrom(node({ type: "document", source: "imported" })), true);
  assert.equal(canFollowUpFrom(node({ type: "post" })), true);
  // An exchange that has not finished takes no follow-up, checkpoint or not.
  assert.equal(canFollowUpFrom(node({ status: "running", sessionReady: true })), false);
});
