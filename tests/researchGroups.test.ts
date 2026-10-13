import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, {
  researchFeedRows,
  type ResearchActivityFeedProps,
} from "../src/components/research/ResearchActivityFeed";
import { researchTreeDeleteDialogProps } from "../src/components/research/ResearchTreeMenu";
import { ResearchDeleteDialogPanel } from "../src/components/research/ResearchDeleteDialog";
import { emptyResearchFolderState, RESEARCH_DRAFTS_FOLDER_ID } from "../src/lib/researchFolders";
import {
  researchCardDropZone,
  researchChildCount,
  researchChildIds,
  researchFolderStateWithGroupCollapsed,
  researchFolderStateWithParent,
  researchGroupSummary,
  researchItemCount,
  researchNestCandidates,
  researchNestRefusal,
  researchOrderAfterMoveOut,
  researchOrderAfterNest,
  researchTreeGroups,
  researchTreeHoldsChildren,
} from "../src/lib/researchGroups";
import { researchTrashTreeSentence } from "../src/lib/researchTrash";
import type { RecentResearchQuery, ResearchFolderState, ResearchTreeSummary } from "../src/types";

function tree(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id, title: `Title ${id}`, rootNodeId: `${id}-root`, type: "exchange", workspaceId: "ws",
    runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 1,
    archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false, ...overrides,
  };
}

function root(id: string, overrides: Partial<RecentResearchQuery> = {}): RecentResearchQuery {
  return {
    nodeId: `${id}-root`, treeId: id, parentNodeId: null, inline: false,
    prompt: `Question ${id}`, adapter: "codex", status: "complete", createdAt: 1, ...overrides,
  };
}

const ids = (trees: { id: string }[]) => trees.map((entry) => entry.id);

test("questions and documents hold children; posts do not", () => {
  assert.equal(researchTreeHoldsChildren("exchange"), true);
  assert.equal(researchTreeHoldsChildren("document"), true);
  assert.equal(researchTreeHoldsChildren("post"), false);
  assert.equal(researchTreeHoldsChildren(undefined), false);
});

test("a list groups children under their listed parent, one level deep", () => {
  const trees = ["a", "c1", "b", "c2", "orphan", "deep"].map((id) => tree(id));
  const parents = { c1: "a", c2: "a", orphan: "elsewhere", deep: "c1", b: "b" };
  const groups = researchTreeGroups(trees, parents);
  // A child whose parent is not in the list, or is itself a child, is listed
  // on its own; a link to itself is ignored.
  assert.deepEqual(ids(groups.map((group) => group.tree)), ["a", "b", "orphan", "deep"]);
  assert.deepEqual(ids(groups[0].children), ["c1", "c2"]);
  assert.deepEqual(researchChildIds("a", trees, parents), ["c1", "c2"]);
});

test("nesting takes the parent's folder; moving out keeps it; collapse is per parent", () => {
  let state: ResearchFolderState = {
    ...emptyResearchFolderState(),
    membership: { p: "f1", c: RESEARCH_DRAFTS_FOLDER_ID },
    collapsedGroups: ["c"],
  };
  state = researchFolderStateWithParent(state, "c", "p");
  assert.deepEqual(state.parents, { c: "p" });
  assert.equal(state.membership.c, "f1");
  assert.deepEqual(state.collapsedGroups, []);
  // A parent in Unfiled has no membership, so neither does its child.
  const unfiled = researchFolderStateWithParent({ ...state, membership: { c: "f1" } }, "c", "q");
  assert.equal("c" in unfiled.membership, false);
  const out = researchFolderStateWithParent(state, "c", null);
  assert.deepEqual(out.parents, {});
  assert.equal(out.membership.c, "f1");
  assert.equal(researchFolderStateWithParent(out, "c", null), out);
  const collapsed = researchFolderStateWithGroupCollapsed(state, "p", true);
  assert.deepEqual(collapsed.collapsedGroups, ["p"]);
  assert.equal(researchFolderStateWithGroupCollapsed(collapsed, "p", true), collapsed);
  assert.deepEqual(researchFolderStateWithGroupCollapsed(collapsed, "p", false).collapsedGroups, []);
});

test("a parent's card has reorder edges of a quarter of its height, 8 to 14px; other cards split at the midpoint", () => {
  // 80px card: 14px edges (a quarter is 20).
  assert.equal(researchCardDropZone(80, 13, true), "before");
  assert.equal(researchCardDropZone(80, 14, true), "nest");
  assert.equal(researchCardDropZone(80, 66, true), "nest");
  assert.equal(researchCardDropZone(80, 67, true), "after");
  // 24px card: 8px edges (a quarter is 6).
  assert.equal(researchCardDropZone(24, 7, true), "before");
  assert.equal(researchCardDropZone(24, 12, true), "nest");
  assert.equal(researchCardDropZone(24, 17, true), "after");
  // 48px card: 12px edges.
  assert.equal(researchCardDropZone(48, 11, true), "before");
  assert.equal(researchCardDropZone(48, 37, true), "after");
  assert.equal(researchCardDropZone(80, 40, false), "before");
  assert.equal(researchCardDropZone(80, 41, false), "after");
});

test("an item can't nest under itself or into its own group", () => {
  assert.equal(researchNestRefusal("a", "a", {}), "Can’t nest an item under itself.");
  assert.equal(researchNestRefusal("p", "c", { c: "p" }), "Can’t move a group into itself.");
  assert.equal(researchNestRefusal("a", "b", {}), null);
});

test("nesting places the child in the group's flat order; Move out places it after the group", () => {
  const flat = ["x", "p", "c1", "c2", "y", "z"];
  // At the end of the group: after the last child.
  assert.deepEqual(researchOrderAfterNest(flat, "p", ["c1", "c2"], "z", null), ["x", "p", "c1", "c2", "z", "y"]);
  // Before a child.
  assert.deepEqual(researchOrderAfterNest(flat, "p", ["c1", "c2"], "x", "c2"), ["p", "c1", "x", "c2", "y", "z"]);
  // The first child goes right after its parent.
  assert.deepEqual(researchOrderAfterNest(["p", "y", "z"], "p", [], "z", null), ["p", "z", "y"]);
  // Move out: before the next top-level item, or at the end.
  assert.deepEqual(researchOrderAfterMoveOut(flat, ["x", "p", "y", "z"], "p", "c1"), ["x", "p", "c2", "c1", "y", "z"]);
  assert.deepEqual(researchOrderAfterMoveOut(["p", "c1", "c2", "x"], ["p"], "p", "c1", ["c2"]), ["p", "c2", "c1", "x"]);
});

test("a collapsed group counts running, failed and updated children", () => {
  assert.deepEqual(
    researchGroupSummary([
      { state: "running", unread: false },
      { state: "queued", unread: false },
      { state: "failed", unread: true },
      { state: "answered", unread: true },
      { state: "answered", unread: false },
      { state: "stopped", unread: true },
    ]),
    { running: 2, failed: 1, updated: 1 },
  );
  assert.equal(researchItemCount(1), "1 item");
  assert.equal(researchItemCount(3), "3 items");
  assert.equal(researchChildCount(1), "1 child");
  assert.equal(researchChildCount(2), "2 children");
});

test("Make child of… keeps the nearest eligible items of a long list, in list order", () => {
  const list = Array.from({ length: 10 }, (_, index) => `t${index}`);
  const eligible = (id: string) => id !== "t5" && id !== "t6";
  assert.deepEqual(researchNestCandidates(list, "t5", eligible, 20), list.filter(eligible));
  assert.deepEqual(researchNestCandidates(list, "t5", eligible, 3), ["t3", "t4", "t7"]);
});

test("Home's rows list children under their parent and keep collapse per row", () => {
  const trees = [tree("p"), tree("c1"), tree("q", { type: "post" }), tree("c2")];
  const roots = new Map(["p", "c1", "q"].map((id) => [id, root(id)]));
  const rows = researchFeedRows(roots, trees, () => "system:unfiled", { c1: "p", c2: "p" }, new Set(["p"]));
  assert.deepEqual(rows.map((row) => row.treeId), ["p", "q"]);
  assert.deepEqual(rows[0].children.map((child) => child.tree.id), ["c1", "c2"]);
  assert.equal(rows[0].children[0].query?.nodeId, "c1-root");
  assert.equal(rows[0].children[1].query, undefined);
  assert.deepEqual(rows.map((row) => row.collapsed), [true, false]);
  assert.deepEqual(rows.map((row) => row.position), [1, 2]);
});

const noop = () => {};
const asyncNoop = async () => {};

function renderFeed(overrides: Partial<ResearchActivityFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchActivityFeed, {
    composer: null,
    items: [], researchTrees: [],
    onOpenResearchQuery: noop,
    onResearchRecapApplied: noop, onError: noop,
    onRenameResearch: asyncNoop,
    onRestoreResearch: asyncNoop, onTrashResearch: asyncNoop, onRemoveResearch: asyncNoop,
    onMoveTree: noop, onDragStart: noop,
    ...overrides,
  }));
}

test("a parent's card has a toggle line and its children follow it as indented cards", () => {
  const trees = [
    tree("p"),
    tree("c1", { runningCount: 1 }),
    tree("c2", { hasUnseenUpdate: true }),
    tree("note", { type: "post" }),
  ];
  const items = [root("p"), root("c1"), root("c2"), root("note", { type: "post", format: "text" })];
  const folderState = { ...emptyResearchFolderState(), parents: { c1: "p", c2: "p" } };
  const html = renderFeed({ items, researchTrees: trees, folderState });
  assert.match(html, /aria-expanded="true" aria-label="Hide 2 items under “Title p”"/);
  assert.match(html, /<span>2 items<\/span>/);
  assert.match(html, /class="research-feed-group"/);
  // Children carry their parent for drag and drop and name it to assistive
  // technology; the parent takes nest drops, a note does not.
  assert.match(html, /data-research-card="c1"[^>]*data-research-parent="p"/);
  assert.match(html, /aria-label="Title c1. Question c1, in “Title p”"/);
  assert.match(html, /data-research-card="p"[^>]*data-research-holds-children=""[^>]*data-research-children="2"/);
  assert.doesNotMatch(html, /data-research-card="note"[^>]*data-research-holds-children/);
  assert.doesNotMatch(html, /data-research-card="c1"[^>]*data-research-holds-children/);
  // Expanded, the toggle shows no counts.
  assert.doesNotMatch(html, /research-feed-group-summary/);
  assert.ok(html.indexOf('data-research-card="p"') < html.indexOf('data-research-card="c1"'));
  assert.ok(html.indexOf('data-research-card="c2"') < html.indexOf('data-research-card="note"'));

  const collapsed = renderFeed({
    items, researchTrees: trees,
    folderState: { ...folderState, collapsedGroups: ["p"] },
  });
  assert.match(collapsed, /aria-expanded="false" aria-label="Show 2 items under “Title p”"/);
  assert.match(collapsed, /data-research-group-collapsed=""/);
  assert.doesNotMatch(collapsed, /data-research-card="c1"/);
  assert.match(collapsed, /class="is-running" title="1 running"/);
  assert.match(collapsed, /class="is-updated" title="1 updated"/);
});

test("a folder tray groups its trees the same way", () => {
  const trees = [tree("p"), tree("c")];
  const folderState: ResearchFolderState = {
    ...emptyResearchFolderState(),
    folders: [{ id: "f1", name: "Reading", workspaceId: "ws" }],
    membership: { p: "f1", c: "f1" },
    parents: { c: "p" },
  };
  const html = renderFeed({
    items: [root("p"), root("c")], researchTrees: trees, folderState, folders: folderState.folders,
  });
  assert.match(html, /research-feed-tray-body[\s\S]*data-research-card="p"[\s\S]*class="research-feed-group"[\s\S]*data-research-parent="p"/);
});

test("deleting a parent names its children, and the Trash keeps them together", () => {
  const props = researchTreeDeleteDialogProps({
    tree: tree("p", { title: "Gum" }),
    groupChildren: [tree("c1"), tree("c2", { runningCount: 1 })],
    onClose: noop, onTrash: asyncNoop, onRemove: asyncNoop,
  });
  const first = renderToStaticMarkup(createElement(ResearchDeleteDialogPanel, props));
  assert.match(first, /Delete “Gum” and its 2 children\?/);
  assert.match(first, /It moves to the Trash with its 2 children. Restoring it restores its children too./);
  assert.match(first, /One of its children has active runs/);
  const second = renderToStaticMarkup(createElement(ResearchDeleteDialogPanel, { ...props, initialStep: "remove" }));
  assert.match(second, /“Gum” and its 2 children will be deleted. This can’t be undone./);
  assert.equal(
    researchTrashTreeSentence(2, 1),
    "It moves to the Trash with its 2 follow-ups and its 1 child. Restoring it restores its child too.",
  );
  assert.equal(researchTrashTreeSentence(1), "It moves to the Trash with its 1 follow-up, where you can restore it.");
});
