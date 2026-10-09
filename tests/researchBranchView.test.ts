import assert from "node:assert/strict";
import test from "node:test";
import {
  researchBranchesByParent,
  researchBranchesOf,
  researchChainHead,
  researchDrawerWidth,
  researchMainChainAncestor,
  researchNodePlacement,
  researchParentBranchHead,
  researchQueueStep,
} from "../src/lib/researchBranchView";
import type { ResearchNode } from "../src/types";

function node(id: string, overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id,
    treeId: "tree",
    prompt: id,
    adapter: "claude",
    groupId: "ws",
    worktreeDir: "/ws",
    status: "complete",
    nativeSessionId: `session-${id}`,
    createdAt: 0,
    highlights: [],
    ...overrides,
  };
}

// root → c2 → c3 (the conversation); b1 branches from c2, b2 from b1, b1f
// continues b1 inline, and b3/b4 are sibling branches of c3.
const nodes = [
  node("root", { createdAt: 0 }),
  node("c2", { parentNodeId: "root", inline: true, createdAt: 1 }),
  node("c3", { parentNodeId: "c2", inline: true, createdAt: 2 }),
  node("b1", { parentNodeId: "c2", createdAt: 3 }),
  node("b1f", { parentNodeId: "b1", inline: true, createdAt: 4 }),
  node("b2", { parentNodeId: "b1f", createdAt: 5 }),
  node("b4", { parentNodeId: "c3", createdAt: 7 }),
  node("b3", { parentNodeId: "c3", createdAt: 6 }),
];
const main = ["root", "c2", "c3"];

test("branches are non-inline children in creation order", () => {
  assert.deepEqual(researchBranchesOf(nodes, "c3").map((item) => item.id), ["b3", "b4"]);
  assert.deepEqual(researchBranchesOf(nodes, "root"), []);
  const byParent = researchBranchesByParent(nodes);
  assert.deepEqual(byParent.get("c3")?.map((item) => item.id), ["b3", "b4"]);
  assert.deepEqual(byParent.get("b1f")?.map((item) => item.id), ["b2"]);
  assert.equal(byParent.has("root"), false);
});

test("a node shows in the conversation, its pinned column, or the drawer", () => {
  assert.deepEqual(researchNodePlacement(nodes, main, [], "c3"), { kind: "main" });
  assert.deepEqual(researchNodePlacement(nodes, main, [], "b1f"), { kind: "drawer", headId: "b1" });
  assert.deepEqual(researchNodePlacement(nodes, main, ["b1"], "b1f"), { kind: "pinned", headId: "b1" });
  assert.equal(researchChainHead(nodes, "b1f"), "b1");
});

test("the drawer's back button leads to the parent branch, never the conversation", () => {
  assert.equal(researchParentBranchHead(nodes, main, "b2"), "b1");
  assert.equal(researchParentBranchHead(nodes, main, "b1"), null);
  assert.equal(researchParentBranchHead(nodes, main, "missing"), null);
});

test("closing a branch returns to the conversation turn it descends from", () => {
  assert.equal(researchMainChainAncestor(nodes, main, "b2"), "c2");
  assert.equal(researchMainChainAncestor(nodes, main, "c3"), "c3");
  assert.equal(researchMainChainAncestor(nodes, main, "missing"), "root");
});

test("the drawer takes 46% of the column area within 380–640px and covers it below 620px", () => {
  assert.equal(researchDrawerWidth(1230, 910), 566);
  assert.equal(researchDrawerWidth(890, 620), 409);
  assert.equal(researchDrawerWidth(700, 460), 380);
  assert.equal(researchDrawerWidth(2000, 1680), 640);
  // Never wider than the conversation column it overlays.
  assert.equal(researchDrawerWidth(700, 360), 360);
  assert.equal(researchDrawerWidth(600, 600), 600);
});

test("a queued follow-up waits for the running tail, then sends or stalls", () => {
  assert.equal(researchQueueStep(node("t", { status: "running" })), "wait");
  assert.equal(researchQueueStep(node("t", { status: "queued" })), "wait");
  assert.equal(researchQueueStep(node("t", { status: "complete" })), "send");
  // A finished run still waits for its session checkpoint.
  assert.equal(researchQueueStep(node("t", { status: "complete", nativeSessionId: null })), "wait");
  assert.equal(researchQueueStep(node("t", { status: "failed" })), "stalled");
  assert.equal(researchQueueStep(node("t", { status: "cancelled" })), "stalled");
  assert.equal(researchQueueStep(null), "wait");
});
