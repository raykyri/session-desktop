import assert from "node:assert/strict";
import test from "node:test";
import {
  followUpAdapter,
  followUpLaunch,
  nodeMessage,
  nodeType,
  postFollowUpSourceExcerpt,
  recapEligible,
} from "@session/shared/lib/researchNodeTypes";
import { canFollowUpFrom } from "@session/shared/lib/researchChains";
import type { AgentAdapterMetadata, ResearchMessageAttachment, ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";
import { recentResearchQueryFromNode } from "@session/shared/lib/activity";

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

test("a note's follow-up quotes the note's text", () => {
  const post = node({
    id: "post",
    type: "post",
    prompt: "Has anyone compared **RLHF** and `DPO`\n on long-horizon tasks?",
  });
  assert.equal(postFollowUpSourceExcerpt(post), "Has anyone compared RLHF and DPO on long-horizon tasks?");
  // Long text is cut at a word boundary, the ellipsis within the limit.
  const cut = postFollowUpSourceExcerpt(post, 30);
  assert.equal(cut, "Has anyone compared RLHF and…");
  assert.ok(cut!.length <= 30);
  // Only posts have a follow-up source excerpt.
  assert.equal(postFollowUpSourceExcerpt(node({ id: "q" })), null);
});

test("a follow-up's agent is the one the backend picks for its parent", () => {
  const adapter = (id: string, fields: Partial<AgentAdapterMetadata> = {}) =>
    ({ id, label: id, default: false, supportsResearch: true, researchReadiness: "ready", ...fields }) as AgentAdapterMetadata;
  const adapters = [adapter("grok"), adapter("claude", { default: true }), adapter("shell", { supportsResearch: false })];
  // An exchange forks its own agent.
  assert.equal(followUpAdapter(node({ adapter: "grok" }), adapters), "grok");
  // A post, imported report or transcript uses its follow-up agent if it
  // supports research.
  assert.equal(followUpAdapter(node({ type: "post", adapter: "grok" }), adapters), "grok");
  assert.equal(followUpAdapter(node({ type: "document", source: "imported", adapter: "grok" }), adapters), "grok");
  assert.equal(followUpAdapter(node({ type: "post", adapter: "shell" }), adapters), "claude");
  // An authored document always uses the default ready research agent.
  assert.equal(followUpAdapter(node({ type: "document", adapter: "grok" }), adapters), "claude");
  const notReady = [adapter("grok"), adapter("claude", { default: true, researchReadiness: "missing" })];
  assert.equal(followUpAdapter(node({ type: "document", adapter: "claude" }), notReady), "grok");
  assert.equal(followUpAdapter(node({ type: "document" }), []), null);
});
