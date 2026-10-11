import assert from "node:assert/strict";
import test from "node:test";
import {
  canContinueChain,
  canFollowUpFrom,
  canRetryResearchNode,
  canStopResearchNode,
  chainDisplayOrder,
  inlineChainFor,
  inlineChildOf,
  isActiveResearchStatus,
  researchChainStopTarget,
  chainComposerPlaceholder,
} from "../src/lib/researchChains";
import type { ResearchNode, ResearchNodeStatus } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

function node(
  id: string,
  overrides: NodeFixture = {},
): ResearchNode {
  return researchNode({
    id,
    treeId: "tree-1",
    prompt: `Prompt ${id}`,
    adapter: "claude",
    groupId: "group-1",
    status: "complete" as ResearchNodeStatus,
    sessionReady: true,
    createdAt: 1,
    highlights: [],
    ...overrides,
  });
}

test("a lone node is a chain of itself", () => {
  const nodes = [node("root")];
  assert.deepEqual(inlineChainFor(nodes, "root"), ["root"]);
  assert.equal(inlineChildOf(nodes, "root"), null);
});

test("an unknown node degrades to a single-entry chain", () => {
  assert.deepEqual(inlineChainFor([node("root")], "missing"), ["missing"]);
});

test("chains walk up to the head and down to the tail from any member", () => {
  const nodes = [
    node("root"),
    node("f1", { parentNodeId: "root", inline: true, createdAt: 2 }),
    node("f2", { parentNodeId: "f1", inline: true, createdAt: 3 }),
    node("branch", { parentNodeId: "root", createdAt: 2 }),
  ];
  const expected = ["root", "f1", "f2"];
  assert.deepEqual(inlineChainFor(nodes, "root"), expected);
  assert.deepEqual(inlineChainFor(nodes, "f1"), expected);
  assert.deepEqual(inlineChainFor(nodes, "f2"), expected);
});

test("branch children start their own chains", () => {
  const nodes = [
    node("root"),
    node("f1", { parentNodeId: "root", inline: true, createdAt: 2 }),
    node("branch", { parentNodeId: "root", createdAt: 2 }),
    node("branch-f1", { parentNodeId: "branch", inline: true, createdAt: 3 }),
  ];
  assert.deepEqual(inlineChainFor(nodes, "branch"), ["branch", "branch-f1"]);
  assert.deepEqual(inlineChainFor(nodes, "branch-f1"), ["branch", "branch-f1"]);
  // The branch's chain never merges into the parent chain.
  assert.deepEqual(inlineChainFor(nodes, "root"), ["root", "f1"]);
});

test("Stop targets the running inline follow-up while an earlier answer is selected", () => {
  const root = node("root");
  const followup = node("followup", { parentNodeId: "root", inline: true, status: "running" });
  const branch = node("branch", { parentNodeId: "root", status: "running" });
  const nodes = [root, followup, branch];
  for (const selected of ["root", "followup"]) {
    const chain = inlineChainFor(nodes, selected).map((id) => nodes.find((item) => item.id === id)!);
    assert.equal(researchChainStopTarget(chain)?.id, "followup");
  }
  const branchChain = inlineChainFor(nodes, "branch").map((id) => nodes.find((item) => item.id === id)!);
  assert.equal(researchChainStopTarget(branchChain)?.id, "branch");
  assert.equal(researchChainStopTarget([root]), null);
});

test("Stop is available during queuing and startup and disappears after settlement", () => {
  for (const status of ["queued", "starting", "running"] as const) {
    assert.equal(canStopResearchNode(node("run", { status })), true);
  }
  for (const status of ["complete", "failed", "cancelled"] as const) {
    assert.equal(researchChainStopTarget([node("run", { status })]), null);
  }
  assert.equal(researchChainStopTarget([]), null);
});

test("Retry stop remains available for incomplete pane cleanup but not settled SDK runs", () => {
  const stopping = node("run", { status: "cancelled", holdsProcess: true });
  assert.equal(researchChainStopTarget([stopping])?.id, "run");
  assert.equal(canStopResearchNode(node("sdk", { status: "cancelled", holdsProcess: false })), false);
});

test("branch children never appear as inline children", () => {
  const nodes = [node("root"), node("branch", { parentNodeId: "root" })];
  assert.equal(inlineChildOf(nodes, "root"), null);
});

test("duplicate inline children resolve to the oldest, stably", () => {
  const nodes = [
    node("root"),
    node("late", { parentNodeId: "root", inline: true, createdAt: 5 }),
    node("early", { parentNodeId: "root", inline: true, createdAt: 2 }),
  ];
  assert.equal(inlineChildOf(nodes, "root")?.id, "early");
  assert.deepEqual(inlineChainFor(nodes, "root"), ["root", "early"]);
  // The losing duplicate stays viewable: it heads its own chain (rendered
  // like a branch child) instead of resolving to a page that never shows it.
  assert.deepEqual(inlineChainFor(nodes, "late"), ["late"]);
});

test("a parent-link cycle cannot hang the walk", () => {
  const nodes = [
    node("a", { parentNodeId: "b", inline: true }),
    node("b", { parentNodeId: "a", inline: true }),
  ];
  const chain = inlineChainFor(nodes, "a");
  assert.ok(chain.length >= 1 && chain.length <= 2);
});

test("canContinueChain requires completion", () => {
  for (const status of ["queued", "starting", "running", "failed", "cancelled"] as const) {
    const tail = node("tail", { status });
    assert.equal(canContinueChain([tail], tail), false);
  }
  const tail = node("tail");
  assert.equal(canContinueChain([tail], tail), true);
});

test("canContinueChain requires a free inline slot, any child status", () => {
  for (const status of [
    "queued",
    "running",
    "complete",
    "failed",
    "cancelled",
  ] as const) {
    const tail = node("tail");
    const child = node("child", { parentNodeId: "tail", inline: true, status });
    assert.equal(canContinueChain([tail, child], tail), false);
  }
  // A branch child leaves the slot free.
  const tail = node("tail");
  const branch = node("branch", { parentNodeId: "tail" });
  assert.equal(canContinueChain([tail, branch], tail), true);
});

test("isActiveResearchStatus matches only unsettled statuses", () => {
  assert.equal(isActiveResearchStatus("queued"), true);
  assert.equal(isActiveResearchStatus("starting"), true);
  assert.equal(isActiveResearchStatus("running"), true);
  assert.equal(isActiveResearchStatus("complete"), false);
  assert.equal(isActiveResearchStatus("failed"), false);
  assert.equal(isActiveResearchStatus("cancelled"), false);
});

test("canFollowUpFrom gates on completion and the run checkpoint", () => {
  assert.equal(canFollowUpFrom(node("done")), true);
  assert.equal(canFollowUpFrom(node("running", { status: "running" })), false);
  assert.equal(canFollowUpFrom(node("unforked", { sessionReady: false })), false);
  assert.equal(
    canFollowUpFrom(node("doc", { type: "document", sessionReady: false })),
    true,
  );
  assert.equal(
    canFollowUpFrom(node("conv", { type: "document", source: "transcript", sessionReady: false })),
    true,
  );
});

test("canRetryResearchNode allows settled failures without a lingering pane", () => {
  assert.equal(canRetryResearchNode(node("failed", { status: "failed" })), true);
  assert.equal(
    canRetryResearchNode(node("cancelled", { status: "cancelled" })),
    true,
  );
  // A still-bound pane means the previous run's process may linger — the
  // cancel controls own that recovery, not retry.
  assert.equal(
    canRetryResearchNode(node("stuck", { status: "failed", holdsProcess: true })),
    false,
  );
  assert.equal(
    canRetryResearchNode(
      node("stuck-cancel", { status: "cancelled", holdsProcess: true }),
    ),
    false,
  );
  assert.equal(canRetryResearchNode(node("done")), false);
  for (const status of ["queued", "starting", "running"] as const) {
    assert.equal(canRetryResearchNode(node("active", { status })), false);
  }
});

test("imported reports allow follow-ups without a native session checkpoint", () => {
  const report = node("report", { type: "document", source: "imported", sessionReady: false });
  assert.equal(canFollowUpFrom(report), true);
  assert.equal(canContinueChain([report], report), true);
  const child = node("child", { parentNodeId: report.id, inline: true, sessionReady: false });
  assert.equal(canContinueChain([report, child], report), false);
  assert.equal(canFollowUpFrom(child), false);
});

test("run tails need the session checkpoint; documents and conversations do not", () => {
  const unforked = node("tail", { sessionReady: false });
  assert.equal(canContinueChain([unforked], unforked), false);
  const document = node("doc", { type: "document", sessionReady: false });
  assert.equal(canContinueChain([document], document), true);
  const conversation = node("conv", { type: "document", source: "transcript", sessionReady: false });
  assert.equal(canContinueChain([conversation], conversation), true);
});

test("every document asks about itself until its first follow-up", () => {
  const authored = node("doc", { type: "document", source: "authored" });
  const imported = node("report", { type: "document", source: "imported" });
  const transcript = node("conv", { type: "document", source: "transcript" });
  // An imported report keeps its question, but follow-ups start a fresh run
  // with the report as context, as for any document.
  assert.equal(chainComposerPlaceholder(authored, 1, false), "Ask about this document");
  assert.equal(chainComposerPlaceholder(imported, 1, false), "Ask about this document");
  assert.equal(chainComposerPlaceholder(transcript, 1, false), "Ask about this conversation");
  assert.equal(chainComposerPlaceholder(imported, 2, false), "Ask a follow-up");
  assert.equal(chainComposerPlaceholder(node("q"), 1, false), "Ask a follow-up");
  assert.equal(chainComposerPlaceholder(node("q"), 1, true), "Ask a follow-up (queued)");
});

test("a messages column lists its chain oldest first, or in the stored order", () => {
  const chain = ["root", "c1", "c2", "c3"];
  assert.deepEqual(chainDisplayOrder(chain, undefined), ["root", "c1", "c2", "c3"]);
  assert.deepEqual(chainDisplayOrder(chain, []), ["root", "c1", "c2", "c3"]);
  // Stored after c2: c3, asked since, lists last; ids no longer in the
  // chain and repeats are dropped.
  assert.deepEqual(
    chainDisplayOrder(chain, ["c1", "gone", "root", "c2", "c1"]),
    ["c1", "root", "c2", "c3"],
  );
  assert.deepEqual(chainDisplayOrder(["root"], ["root"]), ["root"]);
});

test("a follow-up continues the chain's last message, wherever it lists", () => {
  const nodes = [
    node("root", { createdAt: 0, chainOrder: ["c2", "root", "c1"] }),
    node("c1", { parentNodeId: "root", inline: true, createdAt: 1 }),
    node("c2", { parentNodeId: "c1", inline: true, createdAt: 2 }),
  ];
  const chain = inlineChainFor(nodes, "root");
  assert.deepEqual(chain, ["root", "c1", "c2"]);
  assert.deepEqual(chainDisplayOrder(chain, nodes[0].chainOrder), ["c2", "root", "c1"]);
  // The ask box sends from the chain's tail, c2, not from the bottom row.
  const tail = nodes.find((candidate) => candidate.id === chain[chain.length - 1])!;
  assert.equal(tail.id, "c2");
  assert.equal(canContinueChain(nodes, tail), true);
  assert.equal(canContinueChain(nodes, nodes.find((candidate) => candidate.id === "c1")!), false);
});
