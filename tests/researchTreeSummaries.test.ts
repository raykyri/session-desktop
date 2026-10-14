import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionResearchTrees,
  patchResearchTreeSummaries,
  removeResearchTreeSummary,
  replaceResearchActivityForTree,
  upsertResearchTreeSummary,
} from "@session/shared/lib/researchTreeSummaries";
import type { ResearchTreeSummary } from "../src/types";
import { researchNode } from "./researchNodeFixture";

function tree(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id,
    title: `Thread ${id}`,
    rootNodeId: `${id}-root`,
    type: "exchange",
    workspaceId: "workspace",
    runningCount: 0,
    failedCount: 0,
    completedCount: 1,
    cancelledCount: 0,
    updatedAt: 1,
    archivedAt: null,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
    ...overrides,
  };
}

test("trees partition into active and archived lists in order", () => {
  const trees = [tree("a"), tree("b", { archivedAt: 5 }), tree("c")];
  const { active, archived } = partitionResearchTrees(trees);
  assert.deepEqual(active.map((item) => item.id), ["a", "c"]);
  assert.deepEqual(archived.map((item) => item.id), ["b"]);
});

test("upserting replaces a tree in place or adds it at either end", () => {
  const trees = [tree("a"), tree("b")];
  const renamed = tree("b", { title: "Renamed" });
  assert.deepEqual(upsertResearchTreeSummary(trees, renamed), [trees[0], renamed]);
  assert.deepEqual(
    upsertResearchTreeSummary(trees, tree("c")).map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    upsertResearchTreeSummary(trees, tree("c"), true).map((item) => item.id),
    ["c", "a", "b"],
  );
  assert.equal(upsertResearchTreeSummary(trees, trees[1]), trees);
});

test("removing keeps the list when the tree is absent", () => {
  const trees = [tree("a"), tree("b")];
  assert.deepEqual(removeResearchTreeSummary(trees, "a"), [trees[1]]);
  assert.equal(removeResearchTreeSummary(trees, "z"), trees);
});

test("patching keeps the list when no tree changes", () => {
  const trees = [tree("a"), tree("b")];
  assert.equal(patchResearchTreeSummaries(trees, (item) => item), trees);
  const patched = patchResearchTreeSummaries(trees, (item) =>
    item.id === "b" ? { ...item, runningCount: 1 } : item,
  );
  assert.notEqual(patched, trees);
  assert.equal(patched[0], trees[0]);
  assert.equal(patched[1].runningCount, 1);
});

test("a tree's activity is replaced by its detail's running nodes in creation order", () => {
  const other = researchNode({ id: "o", treeId: "other", status: "running", createdAt: 2 });
  const stale = researchNode({ id: "s", treeId: "t", status: "running", createdAt: 1 });
  const running = researchNode({ id: "r", treeId: "t", status: "running", createdAt: 3 });
  const done = researchNode({ id: "d", treeId: "t", status: "complete", createdAt: 0 });
  const queued = researchNode({ id: "q", treeId: "t", status: "queued", createdAt: 1 });
  const next = replaceResearchActivityForTree([other, stale], {
    tree: { id: "t", title: "Thread", rootNodeId: "r", workspaceId: "workspace", createdAt: 0, updatedAt: 3 },
    nodes: [running, done, queued],
  });
  assert.deepEqual(next.map((node) => node.id), ["q", "o", "r"]);
});
