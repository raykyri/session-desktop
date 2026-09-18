import test from "ava";

import { researchBranchInfo } from "../src/research/branches.js";
import {
  intersectingResearchHighlightIds,
  isResearchHighlightActionShortcut,
  resolveResearchHighlightOffset,
} from "../src/research/highlights.js";
import {
  RESEARCH_SCROLL_POSITION_TTL_MS,
  isResearchNodeSelectionChange,
  isResearchTreeSelectionChange,
  isSavedResearchAnchor,
  pruneResearchNavigation,
  pruneResearchNavigationNodes,
  recordResearchFollowupDraft,
  recordResearchScrollPosition,
  restoreResearchScrollPosition,
  type SavedResearchNavigation,
} from "../src/research/navigation.js";
import {
  moveResearchTreeIdBy,
  moveResearchTreeIdToGap,
  replaceResearchTreeScopeOrder,
} from "../src/research/order.js";
import {
  clearResearchTreeAttention,
  reconcileResearchActivity,
  reconcileResearchTreeDetail,
  reconcileResearchTreeSummaries,
} from "../src/research/snapshots.js";
import type {
  ResearchHighlight,
  ResearchNode,
  ResearchNodeStatus,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "../src/types/research.js";

function node(
  id: string,
  parentNodeId: string | null,
  status: ResearchNodeStatus = "complete",
): ResearchNode {
  return {
    id,
    treeId: "tree",
    workspaceId: "workspace",
    parentNodeId,
    prompt: id,
    model: "gemini-flash",
    documentIds: [],
    attempt: 1,
    status,
    createdAt: 1,
    highlights: [],
  };
}

function highlight(overrides: Partial<ResearchHighlight["anchor"]> = {}): ResearchHighlight {
  return {
    id: "highlight-1",
    createdAt: 1,
    anchor: {
      version: 1,
      projection: "answer-v1",
      responseRevision: "a".repeat(64),
      start: 7,
      end: 13,
      exact: "target",
      prefix: "before ",
      suffix: " after",
      ...overrides,
    },
  };
}

function tree(id: string, workspaceId: string): ResearchTreeSummary {
  return {
    id,
    title: id,
    rootNodeId: `${id}-root`,
    kind: "run",
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

function treeDetail(nodes: ResearchNode[]): ResearchTreeDetail {
  return {
    tree: {
      id: "tree",
      title: "Tree",
      rootNodeId: "root",
      workspaceId: "workspace",
      createdAt: 1,
      updatedAt: 2,
    },
    nodes,
  };
}

test("research pointer gaps reorder without off-by-one moves", (t) => {
  const ids = ["a", "b", "c", "d"];
  t.deepEqual(moveResearchTreeIdToGap(ids, "b", 4), ["a", "c", "d", "b"]);
  t.deepEqual(moveResearchTreeIdToGap(ids, "d", 1), ["a", "d", "b", "c"]);
  t.is(moveResearchTreeIdToGap(ids, "b", 1), ids);
  t.is(moveResearchTreeIdToGap(ids, "b", 2), ids);
});

test("research keyboard moves stop at section boundaries", (t) => {
  const ids = ["a", "b", "c"];
  t.deepEqual(moveResearchTreeIdBy(ids, "b", -1), ["b", "a", "c"]);
  t.deepEqual(moveResearchTreeIdBy(ids, "b", 1), ["a", "c", "b"]);
  t.is(moveResearchTreeIdBy(ids, "a", -1), ids);
  t.is(moveResearchTreeIdBy(ids, "c", 1), ids);
  t.is(moveResearchTreeIdBy(ids, "missing", 1), ids);
});

test("research reorder replaces only the selected workspace subsequence", (t) => {
  const trees = [tree("a", "one"), tree("x", "two"), tree("b", "one")];
  t.deepEqual(
    replaceResearchTreeScopeOrder(trees, "one", ["b", "a"]).map((item) => item.id),
    ["b", "x", "a"],
  );
  t.is(replaceResearchTreeScopeOrder(trees, "one", ["a"]), trees);
  t.is(replaceResearchTreeScopeOrder(trees, "one", ["a", "a"]), trees);
  t.is(replaceResearchTreeScopeOrder(trees, "one", ["a", "x"]), trees);
});

test("clicking the currently selected research breadcrumb is a no-op", (t) => {
  t.is(isResearchNodeSelectionChange("root-node", "root-node"), false);
});

test("clicking a different research breadcrumb changes the selection", (t) => {
  t.is(isResearchNodeSelectionChange("child-node", "root-node"), true);
  t.is(isResearchNodeSelectionChange(null, "root-node"), true);
});

test("clicking the research tree already displayed is a no-op", (t) => {
  t.is(isResearchTreeSelectionChange("tree", true, "tree"), false);
});

test("a research tree remains selectable when its document is not displayed", (t) => {
  t.is(isResearchTreeSelectionChange("tree", false, "tree"), true);
  t.is(isResearchTreeSelectionChange("tree", true, "other-tree"), true);
});

test("research scroll positions remain available for 15 minutes", (t) => {
  const navigation: SavedResearchNavigation = { scrollByNode: {} };
  recordResearchScrollPosition(navigation, "root-node", 480, 1_000);

  t.is(
    restoreResearchScrollPosition(
      navigation,
      "root-node",
      1_000 + RESEARCH_SCROLL_POSITION_TTL_MS - 1,
    ),
    480,
  );
});

test("research scroll positions expire at 15 minutes", (t) => {
  const navigation: SavedResearchNavigation = { scrollByNode: {} };
  recordResearchScrollPosition(navigation, "root-node", 480, 1_000);

  t.is(
    restoreResearchScrollPosition(navigation, "root-node", 1_000 + RESEARCH_SCROLL_POSITION_TTL_MS),
    0,
  );
  t.is(restoreResearchScrollPosition(undefined, "root-node", 1_000), 0);
});

test("research follow-up drafts retain text and composer mode until cleared", (t) => {
  const navigation: SavedResearchNavigation = { scrollByNode: {} };

  t.is(
    recordResearchFollowupDraft(navigation, "compare the two approaches", "branch", 1_000),
    true,
  );
  t.deepEqual(navigation.followupDraft, {
    text: "compare the two approaches",
    mode: "branch",
    updatedAt: 1_000,
  });
  t.is(recordResearchFollowupDraft(navigation, "", "thread", 2_000), true);
  t.is(navigation.followupDraft, undefined);
  t.is(recordResearchFollowupDraft(navigation, "", "thread", 3_000), false);

  t.is(recordResearchFollowupDraft(navigation, "same text", "thread", 4_000), true);
  t.is(recordResearchFollowupDraft(navigation, "same text", "thread", 5_000), false);
  t.deepEqual(navigation.followupDraft, {
    text: "same text",
    mode: "thread",
    updatedAt: 4_000,
  });
  t.is(recordResearchFollowupDraft(navigation, "same text", "branch", 6_000), true);
  t.deepEqual(navigation.followupDraft, {
    text: "same text",
    mode: "branch",
    updatedAt: 6_000,
  });
});

test("persisted anchors are validated before they are restored", (t) => {
  const anchor = highlight().anchor;
  t.is(isSavedResearchAnchor(anchor), true);
  t.is(isSavedResearchAnchor({ ...anchor, version: 2 }), false);
  t.is(isSavedResearchAnchor({ ...anchor, projection: "transcript-v1" }), false);
  t.is(isSavedResearchAnchor({ ...anchor, start: "7" }), false);
  t.is(isSavedResearchAnchor(null), false);
  t.is(isSavedResearchAnchor("anchor"), false);
});

test("pruning navigation drops trees that no longer exist", (t) => {
  const kept: SavedResearchNavigation = { scrollByNode: {} };
  const navigationByTree: Record<string, SavedResearchNavigation> = {
    "tree-a": kept,
    "tree-b": { scrollByNode: {} },
  };
  t.is(pruneResearchNavigation(navigationByTree, ["tree-a"]), true);
  t.deepEqual(Object.keys(navigationByTree), ["tree-a"]);
  t.is(navigationByTree["tree-a"], kept);
  // A second pass changes nothing, so the caller can skip the write.
  t.is(pruneResearchNavigation(navigationByTree, ["tree-a"]), false);
});

test("pruning navigation nodes drops per-node state for deleted nodes", (t) => {
  const navigation: SavedResearchNavigation = {
    selectedNodeId: "gone",
    scrollByNode: { kept: { top: 10, updatedAt: 1 }, gone: { top: 20, updatedAt: 1 } },
    expandedByNode: { kept: true, gone: true },
    askByNode: {
      gone: { anchor: highlight().anchor, text: "why", updatedAt: 1 },
    },
  };
  t.is(pruneResearchNavigationNodes(navigation, ["kept"]), true);
  t.deepEqual(navigation, {
    scrollByNode: { kept: { top: 10, updatedAt: 1 } },
    expandedByNode: { kept: true },
    askByNode: {},
  });
  t.is(pruneResearchNavigationNodes(navigation, ["kept"]), false);
  t.is(pruneResearchNavigationNodes(undefined, ["kept"]), false);
});

test("branch info includes every descendant but not siblings", (t) => {
  const nodes = [
    node("root", null),
    node("branch", "root"),
    node("child", "branch"),
    node("leaf", "child"),
    node("sibling", "root"),
  ];
  t.deepEqual(researchBranchInfo(nodes, "branch"), {
    nodeIds: ["branch", "child", "leaf"],
    descendantCount: 2,
    hasActiveRuns: false,
  });
});

test("branch info detects active descendants", (t) => {
  const running = [node("branch", "root"), node("child", "branch", "running")];
  t.is(researchBranchInfo(running, "branch")?.hasActiveRuns, true);
  t.is(
    researchBranchInfo([node("branch", "root"), node("child", "branch", "queued")], "branch")
      ?.hasActiveRuns,
    true,
  );
  // An interrupted node has no live run: nothing is executing until the server
  // resumes it, so the branch does not report active runs.
  t.is(
    researchBranchInfo([node("branch", "root"), node("child", "branch", "interrupted")], "branch")
      ?.hasActiveRuns,
    false,
  );
  t.is(researchBranchInfo(running, "missing"), null);
});

test("research highlights relocate only with matching quote context", (t) => {
  const saved = highlight();
  t.deepEqual(
    resolveResearchHighlightOffset("inserted before target after", "a".repeat(64), saved),
    {
      start: 16,
      end: 22,
    },
  );
  t.is(
    resolveResearchHighlightOffset("an unrelated target elsewhere", "a".repeat(64), saved),
    null,
  );
});

test("research highlights survive edits by relocating across revisions", (t) => {
  // A document edit bumps the revision; the highlight follows its quote as
  // long as the surrounding context still agrees.
  t.deepEqual(
    resolveResearchHighlightOffset(
      "edited opening. before target after",
      "b".repeat(64),
      highlight(),
    ),
    { start: 23, end: 29 },
  );
  // The quote is gone from the new revision: orphan it rather than guess.
  t.is(resolveResearchHighlightOffset("nothing to match here", "b".repeat(64), highlight()), null);
});

test("research highlights relocate to a single one-sided match when context is edited", (t) => {
  // An edit rewrote the suffix, so both sides no longer agree; a lone
  // occurrence keeping the prefix is still safe to follow.
  t.deepEqual(
    resolveResearchHighlightOffset("before target rewritten", "b".repeat(64), highlight()),
    {
      start: 7,
      end: 13,
    },
  );
  // Two occurrences each keep only one side: too ambiguous, so orphan it.
  t.is(
    resolveResearchHighlightOffset(
      "before target here and target after",
      "b".repeat(64),
      highlight(),
    ),
    null,
  );
});

test("research highlight removal targets every whole highlight touched by a selection", (t) => {
  const highlights = [
    { id: "first", start: 2, end: 8 },
    { id: "second", start: 10, end: 20 },
    { id: "third", start: 24, end: 30 },
  ];

  t.deepEqual(intersectingResearchHighlightIds({ start: 5, end: 12 }, highlights), [
    "first",
    "second",
  ]);
  t.deepEqual(intersectingResearchHighlightIds({ start: 12, end: 14 }, highlights), ["second"]);
});

test("research highlight removal ignores ranges that only touch an edge", (t) => {
  const highlights = [{ id: "highlight", start: 10, end: 20 }];

  t.deepEqual(intersectingResearchHighlightIds({ start: 5, end: 10 }, highlights), []);
  t.deepEqual(intersectingResearchHighlightIds({ start: 20, end: 25 }, highlights), []);
});

test("H confirms a research highlight action without modifiers or repeat", (t) => {
  const input = {
    key: "h",
    defaultPrevented: false,
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  };

  t.is(isResearchHighlightActionShortcut(input), true);
  t.is(isResearchHighlightActionShortcut({ ...input, key: "H" }), true);
  t.is(isResearchHighlightActionShortcut({ ...input, key: "a" }), false);
  t.is(isResearchHighlightActionShortcut({ ...input, repeat: true }), false);
  t.is(isResearchHighlightActionShortcut({ ...input, metaKey: true }), false);
  t.is(isResearchHighlightActionShortcut({ ...input, ctrlKey: true }), false);
  t.is(isResearchHighlightActionShortcut({ ...input, altKey: true }), false);
  t.is(isResearchHighlightActionShortcut({ ...input, defaultPrevented: true }), false);
});

test("research snapshot reconciliation retains identical collection identities", (t) => {
  const summaries = [tree("first", "workspace"), tree("second", "workspace")];
  const nextSummaries = summaries.map((summary) => ({ ...summary }));
  t.is(reconcileResearchTreeSummaries(summaries, nextSummaries), summaries);

  const activity = [node("running", null, "running")];
  const nextActivity = activity.map((entry) => ({ ...entry, highlights: [] }));
  t.is(reconcileResearchActivity(activity, nextActivity), activity);
});

test("research snapshot reconciliation retains empty collection identities", (t) => {
  const summaries: ResearchTreeSummary[] = [];
  const activity: ResearchNode[] = [];
  t.is(reconcileResearchTreeSummaries(summaries, []), summaries);
  t.is(reconcileResearchActivity(activity, []), activity);

  const detail = treeDetail([]);
  t.is(reconcileResearchTreeDetail(detail, { tree: { ...detail.tree }, nodes: [] }), detail);
});

test("research snapshot reconciliation replaces only changed collection records", (t) => {
  const first = tree("first", "workspace");
  const second = tree("second", "workspace");
  const current = [first, second];
  const reconciled = reconcileResearchTreeSummaries(current, [
    { ...first },
    { ...second, runningCount: 1 },
  ]);

  t.not(reconciled, current);
  t.is(reconciled[0], first);
  t.not(reconciled[1], second);
  t.is(reconciled[1]?.runningCount, 1);
});

test("research detail reconciliation retains identical nested snapshots", (t) => {
  const detail = treeDetail([node("root", null), node("child", "root")]);
  const incoming: ResearchTreeDetail = {
    tree: { ...detail.tree, archivedAt: undefined },
    nodes: detail.nodes.map((entry) => ({ ...entry, highlights: [...entry.highlights] })),
  };

  t.is(reconcileResearchTreeDetail(detail, incoming), detail);
});

test("research detail reconciliation preserves unchanged node identities", (t) => {
  const root = node("root", null);
  const child = node("child", "root");
  const detail = treeDetail([root, child]);
  const reconciled = reconcileResearchTreeDetail(detail, {
    tree: { ...detail.tree },
    nodes: [{ ...root }, { ...child, responsePreview: "New preview" }],
  });

  t.not(reconciled, detail);
  t.is(reconciled.tree, detail.tree);
  t.is(reconciled.nodes[0], root);
  t.not(reconciled.nodes[1], child);
});

test("clearing research attention is an identity-preserving no-op when already viewed", (t) => {
  const viewed = [tree("viewed", "workspace")];
  t.is(clearResearchTreeAttention(viewed, "viewed"), viewed);

  const unseen = viewed.map((summary) => ({
    ...summary,
    hasUnseenUpdate: true,
    hasUnseenFailure: true,
  }));
  const cleared = clearResearchTreeAttention(unseen, "viewed");
  t.not(cleared, unseen);
  t.deepEqual(cleared[0], {
    ...unseen[0],
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  } as ResearchTreeSummary);
});
