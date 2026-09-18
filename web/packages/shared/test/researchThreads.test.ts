import test from "ava";

import {
  ACTIVE_RESEARCH_STATUSES,
  canContinueThread,
  canFollowUpFrom,
  canRetryResearchNode,
  inlineChainFor,
  inlineChildOf,
  isActiveResearchStatus,
} from "../src/research/threads.js";
import type { ResearchNode } from "../src/types/research.js";

function node(id: string, overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id,
    treeId: "tree-1",
    workspaceId: "workspace-1",
    prompt: `Prompt ${id}`,
    model: "gemini-flash",
    documentIds: [],
    attempt: 1,
    status: "complete",
    createdAt: 1,
    highlights: [],
    ...overrides,
  };
}

test("a lone node is a chain of itself", (t) => {
  const nodes = [node("root")];
  t.deepEqual(inlineChainFor(nodes, "root"), ["root"]);
  t.is(inlineChildOf(nodes, "root"), null);
});

test("an unknown node degrades to a single-entry chain", (t) => {
  t.deepEqual(inlineChainFor([node("root")], "missing"), ["missing"]);
});

test("chains walk up to the head and down to the tail from any member", (t) => {
  const nodes = [
    node("root"),
    node("f1", { parentNodeId: "root", inline: true, createdAt: 2 }),
    node("f2", { parentNodeId: "f1", inline: true, createdAt: 3 }),
    node("branch", { parentNodeId: "root", createdAt: 2 }),
  ];
  const expected = ["root", "f1", "f2"];
  t.deepEqual(inlineChainFor(nodes, "root"), expected);
  t.deepEqual(inlineChainFor(nodes, "f1"), expected);
  t.deepEqual(inlineChainFor(nodes, "f2"), expected);
});

test("branch children start their own chains", (t) => {
  const nodes = [
    node("root"),
    node("f1", { parentNodeId: "root", inline: true, createdAt: 2 }),
    node("branch", { parentNodeId: "root", createdAt: 2 }),
    node("branch-f1", { parentNodeId: "branch", inline: true, createdAt: 3 }),
  ];
  t.deepEqual(inlineChainFor(nodes, "branch"), ["branch", "branch-f1"]);
  t.deepEqual(inlineChainFor(nodes, "branch-f1"), ["branch", "branch-f1"]);
  // The branch's chain never merges into the parent chain.
  t.deepEqual(inlineChainFor(nodes, "root"), ["root", "f1"]);
});

test("branch children never appear as inline children", (t) => {
  const nodes = [node("root"), node("branch", { parentNodeId: "root" })];
  t.is(inlineChildOf(nodes, "root"), null);
});

test("duplicate inline children resolve to the oldest, stably", (t) => {
  const nodes = [
    node("root"),
    node("late", { parentNodeId: "root", inline: true, createdAt: 5 }),
    node("early", { parentNodeId: "root", inline: true, createdAt: 2 }),
  ];
  t.is(inlineChildOf(nodes, "root")?.id, "early");
  t.deepEqual(inlineChainFor(nodes, "root"), ["root", "early"]);
  // The losing duplicate stays viewable: it heads its own chain (rendered
  // like a branch child) instead of resolving to a page that never shows it.
  t.deepEqual(inlineChainFor(nodes, "late"), ["late"]);
});

test("a parent-link cycle cannot hang the walk", (t) => {
  const nodes = [
    node("a", { parentNodeId: "b", inline: true }),
    node("b", { parentNodeId: "a", inline: true }),
  ];
  const chain = inlineChainFor(nodes, "a");
  t.true(chain.length >= 1 && chain.length <= 2);
});

test("canContinueThread requires completion", (t) => {
  for (const status of ["queued", "running", "failed", "cancelled", "interrupted"] as const) {
    const tail = node("tail", { status });
    t.is(canContinueThread([tail], tail), false, status);
  }
  const tail = node("tail");
  t.is(canContinueThread([tail], tail), true);
});

test("canContinueThread requires a free inline slot, any child status", (t) => {
  for (const status of [
    "queued",
    "running",
    "complete",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    const tail = node("tail");
    const child = node("child", { parentNodeId: "tail", inline: true, status });
    t.is(canContinueThread([tail, child], tail), false, status);
  }
  // A branch child leaves the slot free.
  const tail = node("tail");
  const branch = node("branch", { parentNodeId: "tail" });
  t.is(canContinueThread([tail, branch], tail), true);
});

test("isActiveResearchStatus matches only admitted, unsettled statuses", (t) => {
  t.deepEqual([...ACTIVE_RESEARCH_STATUSES], ["queued", "running"]);
  t.is(isActiveResearchStatus("queued"), true);
  t.is(isActiveResearchStatus("running"), true);
  t.is(isActiveResearchStatus("complete"), false);
  t.is(isActiveResearchStatus("failed"), false);
  t.is(isActiveResearchStatus("cancelled"), false);
  // `interrupted` is a settled row state: nothing is executing until the
  // server resumes the attempt, which puts the node back into `queued`.
  t.is(isActiveResearchStatus("interrupted"), false);
});

test("canFollowUpFrom gates on completion alone, for every node kind", (t) => {
  t.is(canFollowUpFrom(node("done")), true);
  t.is(canFollowUpFrom(node("running", { status: "running" })), false);
  t.is(canFollowUpFrom(node("interrupted", { status: "interrupted" })), false);
  // No native session checkpoint exists on the web: a document root takes a
  // follow-up on exactly the same terms as a run.
  t.is(canFollowUpFrom(node("doc", { kind: "document" })), true);
  t.is(canFollowUpFrom(node("run", { kind: "run" })), true);
});

test("canRetryResearchNode allows every status resetForRetry accepts", (t) => {
  t.is(canRetryResearchNode(node("failed", { status: "failed" })), true);
  t.is(canRetryResearchNode(node("cancelled", { status: "cancelled" })), true);
  // Auto-resume normally clears an interruption, but after repeated failed
  // resumes the node stays interrupted and Retry is the way out.
  t.is(canRetryResearchNode(node("interrupted", { status: "interrupted" })), true);
  t.is(canRetryResearchNode(node("done")), false);
  for (const status of ["queued", "running"] as const) {
    t.is(canRetryResearchNode(node("active", { status })), false, status);
  }
});

test("document tails continue a thread on the same terms as run tails", (t) => {
  const document = node("doc", { kind: "document" });
  t.is(canContinueThread([document], document), true);
  const run = node("run", { kind: "run" });
  t.is(canContinueThread([run], run), true);
});
