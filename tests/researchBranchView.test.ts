import assert from "node:assert/strict";
import test from "node:test";
import {
  researchBranchesByParent,
  researchBranchesInReadingOrder,
  researchBranchesOf,
  researchEditedQuestionFork,
  researchLevelPath,
  researchQueueAction,
  researchSurvivingAncestor,
  researchQueueStep,
  researchPairLabel,
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

test("branches are non-inline children in creation order", () => {
  assert.deepEqual(researchBranchesOf(nodes, "c3").map((item) => item.id), ["b3", "b4"]);
  assert.deepEqual(researchBranchesOf(nodes, "root"), []);
  const byParent = researchBranchesByParent(nodes);
  assert.deepEqual(byParent.get("c3")?.map((item) => item.id), ["b3", "b4"]);
  assert.deepEqual(byParent.get("b1f")?.map((item) => item.id), ["b2"]);
  assert.equal(byParent.has("root"), false);
});

test("one selection determines every open level: a branch's level follows the message it was asked from", () => {
  assert.deepEqual(researchLevelPath(nodes, "c3"), ["c3"]);
  assert.deepEqual(researchLevelPath(nodes, "root"), ["root"]);
  // b1f continues b1, which was asked from c2; b2 was asked from b1f.
  assert.deepEqual(researchLevelPath(nodes, "b1f"), ["c2", "b1f"]);
  assert.deepEqual(researchLevelPath(nodes, "b2"), ["c2", "b1f", "b2"]);
  assert.deepEqual(researchLevelPath(nodes, "b4"), ["c3", "b4"]);
  assert.deepEqual(researchLevelPath(nodes, "missing"), []);
});

test("an answer's branches read in passage order, then whole-answer branches, oldest first", () => {
  const branches = researchBranchesOf(nodes, "c3");
  const starts: Record<string, number | null> = { b3: 40, b4: 12 };
  assert.deepEqual(
    researchBranchesInReadingOrder(branches, (id) => starts[id] ?? null).map((item) => item.id),
    ["b4", "b3"],
  );
  assert.deepEqual(
    researchBranchesInReadingOrder(branches, (id) => (id === "b4" ? 5 : null)).map((item) => item.id),
    ["b4", "b3"],
  );
  assert.deepEqual(researchBranchesInReadingOrder(branches, () => null).map((item) => item.id), ["b3", "b4"]);
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

const queued = (id: string, failed?: string) => ({ id, prompt: id, createdAt: 0, ...(failed ? { failed } : {}) });

test("a queue sends its first question from the chain's tail once it completes", () => {
  const chain = [node("h"), node("t", { parentNodeId: "h", inline: true, status: "running" })];
  assert.deepEqual(researchQueueAction(chain, "h", [queued("q1"), queued("q2")], undefined), { kind: "wait" });
  const done = [chain[0], { ...chain[1], status: "complete" as const }];
  assert.deepEqual(researchQueueAction(done, "h", [queued("q1"), queued("q2")], undefined), {
    kind: "send",
    item: queued("q1"),
    tailId: "t",
  });
  assert.deepEqual(researchQueueAction(done, "h", [], undefined), { kind: "wait" });
});

test("after a send the queue waits until the new child is in the tree, then follows it", () => {
  const before = [node("h"), node("t", { parentNodeId: "h", inline: true })];
  const rest = [queued("q2")];
  // The fork request is running, then resolved before the detail has the
  // child: the tail in `before` is stale, so nothing is sent from it.
  assert.deepEqual(researchQueueAction(before, "h", rest, true), { kind: "wait" });
  assert.deepEqual(researchQueueAction(before, "h", rest, "c"), { kind: "wait" });
  // The child arrives running: the next question waits for it.
  const running = [...before, node("c", { parentNodeId: "t", inline: true, status: "running" })];
  assert.deepEqual(researchQueueAction(running, "h", rest, "c"), { kind: "wait" });
  // It completes: the next question is sent from the child, not the old tail.
  const complete = [...before, node("c", { parentNodeId: "t", inline: true })];
  assert.deepEqual(researchQueueAction(complete, "h", rest, "c"), { kind: "send", item: queued("q2"), tailId: "c" });
});

test("a refused question holds the queue, a stopped tail stalls it, and a removed head clears it", () => {
  const chain = [node("h"), node("t", { parentNodeId: "h", inline: true })];
  assert.deepEqual(researchQueueAction(chain, "h", [queued("q1", "refused"), queued("q2")], undefined), {
    kind: "wait",
  });
  const stopped = [chain[0], { ...chain[1], status: "failed" as const }];
  assert.deepEqual(researchQueueAction(stopped, "h", [queued("q1")], undefined), { kind: "wait" });
  // A branch from the tail does not block its inline follow-up.
  const continued = [...chain, node("x", { parentNodeId: "t", inline: false })];
  assert.equal(researchQueueAction(continued, "h", [queued("q1")], undefined).kind, "send");
  assert.deepEqual(researchQueueAction([node("other")], "h", [queued("q1")], undefined), { kind: "clear" });
});

test("an edited question forks in place of the failed node instead of removing it first", () => {
  const anchor = { exact: "passage", prefix: "", suffix: "", start: 0, end: 7 } as unknown as NonNullable<
    ResearchNode["queryAnchor"]
  >;
  const failed = node("failed", {
    parentNodeId: "root",
    inline: true,
    status: "failed",
    queryAnchor: anchor,
    replyAnchor: "reply-1",
  });
  // One request: the backend admits the new question, then removes the
  // failed node. A refused send leaves the failed turn and its partial answer.
  assert.deepEqual(researchEditedQuestionFork(failed, "Edited"), {
    parentNodeId: "root",
    prompt: "Edited",
    queryAnchor: anchor,
    inline: true,
    replyAnchor: "reply-1",
    replacesNodeId: "failed",
  });
  assert.deepEqual(researchEditedQuestionFork(node("b", { parentNodeId: "root" }), "Q"), {
    parentNodeId: "root",
    prompt: "Q",
    queryAnchor: null,
    inline: false,
    replyAnchor: null,
    replacesNodeId: "b",
  });
  assert.equal(researchEditedQuestionFork(node("root"), "Q"), null);
});

test("a removed selection falls back to its nearest surviving ancestor", () => {
  const parents = new Map(nodes.map((item) => [item.id, item.parentNodeId ?? null]));
  // b1 (with b1f and b2 under it) is removed: b2 falls back to c2, where b1 was asked.
  const valid = new Set(["root", "c2", "c3", "b3", "b4"]);
  assert.equal(researchSurvivingAncestor(parents, "b2", valid), "c2");
  assert.equal(researchSurvivingAncestor(parents, "b1f", valid), "c2");
  assert.equal(researchSurvivingAncestor(parents, "c3", valid), "c3");
  assert.equal(researchSurvivingAncestor(parents, "unknown", valid), null);
});

test("a pair label is cut at a word boundary with an ellipsis", () => {
  assert.equal(researchPairLabel("  short\n question "), "short question");
  assert.equal(researchPairLabel("alpha beta gamma delta", 14), "alpha beta…");
  assert.equal(researchPairLabel("supercalifragilistic", 10), "supercalif…");
});
