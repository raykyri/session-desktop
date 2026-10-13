import test from "node:test";
import assert from "node:assert/strict";
import type { GroupInfo, ResearchTreeSummary } from "../src/types";
import { groupsForScope, researchAttention } from "../src/lib/workspaceScope";
import {
  resolveResearchScope,
  treeForResearchScope,
  treesForResearchScope,
  workspaceIsInResearchScope,
} from "../src/lib/researchScope";

function group(id: string, scope: GroupInfo["scope"]): GroupInfo {
  return {
    id,
    name: id,
    dir: `/tmp/${id}`,
    managedDir: `/tmp/session/${id}`,
    createdAt: 1,
    collapsed: false,
    scope,
    agents: [],
  };
}

test("groupsForScope returns one scope's groups in order", () => {
  const terminalA = group("terminal-a", "terminal");
  const research = group("research-a", "research");
  const terminalB = group("terminal-b", "terminal");
  const groups = [terminalA, research, terminalB];

  assert.deepEqual(groupsForScope(groups, "terminal").map(({ id }) => id), [
    terminalA.id,
    terminalB.id,
  ]);
  assert.deepEqual(groupsForScope(groups, "research").map(({ id }) => id), [research.id]);
});

test("research attention is derived from durable summaries", () => {
  assert.deepEqual(
    researchAttention([
      {
        id: "tree-a",
        title: "A",
        rootNodeId: "root-a",
        type: "exchange",
        workspaceId: "folder-a",
        runningCount: 2,
        failedCount: 0,
        completedCount: 1,
        cancelledCount: 0,
        updatedAt: 1,
        hasUnseenUpdate: true,
        hasUnseenFailure: false,
      },
      {
        id: "tree-b",
        title: "B",
        rootNodeId: "root-b",
        type: "exchange",
        workspaceId: "folder-b",
        runningCount: 0,
        failedCount: 1,
        completedCount: 0,
        cancelledCount: 1,
        updatedAt: 2,
        hasUnseenUpdate: false,
        hasUnseenFailure: true,
      },
      {
        // An old failure the user already viewed: counted in the lifetime
        // failedCount but no longer demanding attention.
        id: "tree-c",
        title: "C",
        rootNodeId: "root-c",
        type: "exchange",
        workspaceId: "folder-a",
        runningCount: 0,
        failedCount: 3,
        completedCount: 2,
        cancelledCount: 0,
        updatedAt: 3,
        hasUnseenUpdate: false,
        hasUnseenFailure: false,
      },
    ]),
    { runningCount: 2, failedCount: 1, unseenCount: 1 },
  );
});

test("a stored folder scope resolves to itself only while the workspace is live", () => {
  const researchA = group("research-a", "research");
  const researchB = group("research-b", "research");

  assert.equal(resolveResearchScope("research-a", [researchA, researchB]), "research-a");
  assert.equal(resolveResearchScope("research-a", [researchB]), "research-b");
  assert.equal(resolveResearchScope("research-a", []), null);
  assert.equal(resolveResearchScope(null, [researchA]), "research-a");
  assert.equal(resolveResearchScope("all", [researchA]), "research-a");
});

function treeSummary(id: string, workspaceId: string): ResearchTreeSummary {
  return {
    id,
    title: id,
    rootNodeId: `${id}-root`,
    type: "exchange",
    workspaceId,
    runningCount: 0,
    failedCount: 0,
    completedCount: 1,
    cancelledCount: 0,
    updatedAt: 1,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  };
}

test("folder scoping filters trees and returns none without a folder", () => {
  const trees = [
    treeSummary("tree-1", "research-a"),
    treeSummary("tree-2", "research-b"),
    treeSummary("tree-3", "research-a"),
  ];

  assert.deepEqual(treesForResearchScope(trees, null), []);
  assert.deepEqual(
    treesForResearchScope(trees, "research-a").map(({ id }) => id),
    ["tree-1", "tree-3"],
  );
  assert.deepEqual(treesForResearchScope(trees, "research-c"), []);
});

test("research restoration never crosses the selected folder scope", () => {
  const trees = [
    treeSummary("tree-1", "research-a"),
    treeSummary("tree-2", "research-b"),
  ];

  assert.equal(treeForResearchScope(trees, "research-b", "tree-1")?.id, "tree-2");
  assert.equal(treeForResearchScope(trees, "research-c", "tree-1"), null);
  assert.equal(treeForResearchScope(trees, null, "tree-1"), null);
  assert.equal(workspaceIsInResearchScope("research-a", "research-a"), true);
  assert.equal(workspaceIsInResearchScope("research-a", "research-b"), false);
  assert.equal(workspaceIsInResearchScope("research-a", null), false);
});

