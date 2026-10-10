import assert from "node:assert/strict";
import test from "node:test";
import {
  followUpLaunch,
  nodeMessage,
  nodeType,
  postFollowUpSourceExcerpt,
  recapEligible,
} from "../src/lib/researchNodeTypes";
import { canFollowUpFrom } from "../src/lib/researchChains";
import type { ResearchMessageAttachment, ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";
import { recentResearchQueryFromNode } from "../src/lib/activity";

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

test("authored documents and transcripts have no question row", () => {
  const attachments = [{ kind: "tweet" }] as unknown as ResearchMessageAttachment[];
  assert.deepEqual(nodeMessage(node({ attachments })), { text: "What changed?", attachments });
  assert.deepEqual(nodeMessage(node({ type: "post" })), { text: "What changed?", attachments: [] });
  assert.deepEqual(nodeMessage(node({ type: "document", source: "imported" })), {
    text: "What changed?",
    attachments: [],
  });
  assert.equal(nodeMessage(node({ type: "document" })), null);
  // A transcript keeps its first user turn as its message (the feed card's
  // text) but still shows as one row.
  const transcript = node({ type: "document", source: "transcript" });
  assert.equal(transcript.message?.text, "What changed?");
  assert.equal(recentResearchQueryFromNode(transcript)?.prompt, "What changed?");
  assert.equal(nodeMessage(transcript), null);
});

test("follow-ups that fork need the session checkpoint; context launches do not", () => {
  assert.equal(canFollowUpFrom(node({ sessionReady: false })), false);
  assert.equal(canFollowUpFrom(node({ sessionReady: true })), true);
  assert.equal(canFollowUpFrom(node({ type: "document", source: "imported" })), true);
  assert.equal(canFollowUpFrom(node({ type: "post" })), true);
  // An exchange that has not finished takes no follow-up, checkpoint or not.
  assert.equal(canFollowUpFrom(node({ status: "running", sessionReady: true })), false);
});

test("a post's follow-up quotes the reply it was asked about, else the post", () => {
  const post = node({
    id: "post",
    type: "post",
    prompt: "Has anyone compared **RLHF** and `DPO`\n on long-horizon tasks?",
    delivery: {
      status: "posted",
      postedAt: 1,
      replies: [{ id: "r1", author: { kind: "member", id: "ana", displayName: "Ana" }, body: "We saw a plateau.", createdAt: 2 }],
    },
  });
  const whole = node({ id: "fu", parentNodeId: "post" });
  const onReply = node({ id: "fu2", parentNodeId: "post", anchor: { kind: "reply", replyId: "r1" } });
  assert.equal(postFollowUpSourceExcerpt(post, whole), "Has anyone compared RLHF and DPO on long-horizon tasks?");
  assert.equal(postFollowUpSourceExcerpt(post, onReply), "We saw a plateau.");
  // Long text is cut at a word boundary, the ellipsis within the limit.
  const cut = postFollowUpSourceExcerpt(post, whole, 30);
  assert.equal(cut, "Has anyone compared RLHF and…");
  assert.ok(cut!.length <= 30);
  // Only posts have a follow-up source excerpt.
  assert.equal(postFollowUpSourceExcerpt(node({ id: "q" }), whole), null);
});
