import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyResearchFolderState,
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  reorderedIds,
  researchCardTitle,
  researchFeedChildren,
  researchFolderMonogram,
  researchFolderNameError,
  researchFolderStateRenamed,
  researchFolderStateWithCollapsed,
  researchFolderStateWithFolderTrashed,
  researchFolderStateWithMembership,
  researchFolderStateWithNewFolder,
  researchFolderStateWithoutFolder,
  researchDropBeforeId,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreeOrderAfterMove,
  researchTreePlace,
  stepReorderTarget,
  treesWithWorkspaceOrder,
  workspaceResearchFolders,
} from "../src/lib/researchFolders";
import { patchRecentActivityStarred } from "../src/lib/activity";
import { researchMoveTargets } from "../src/components/research/ResearchMoveMenu";
import type { ResearchFolderState, ResearchTreeSummary } from "../src/types";
import { researchNode } from "./researchNodeFixture";

function tree(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id, title: id, rootNodeId: `${id}-root`, type: "exchange", workspaceId: "ws",
    runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 1,
    archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false, ...overrides,
  };
}

const state: ResearchFolderState = {
  folders: [
    { id: "f-read", name: "Reading list", workspaceId: "ws" },
    { id: "f-other", name: "Elsewhere", workspaceId: "ws-2" },
  ],
  membership: { a: "f-read", b: RESEARCH_DRAFTS_FOLDER_ID, c: "f-deleted" },
  collapsed: [],
  parents: {},
  collapsedGroups: [],
};

test("a tree's place: Archive by archivedAt, then its folder or Drafts, else Unfiled", () => {
  assert.equal(researchTreePlace(tree("a"), state), "f-read");
  assert.equal(researchTreePlace(tree("b"), state), RESEARCH_DRAFTS_FOLDER_ID);
  // A membership whose folder no longer exists is classified as Unfiled.
  assert.equal(researchTreePlace(tree("c"), state), RESEARCH_UNFILED_FOLDER_ID);
  assert.equal(researchTreePlace(tree("d"), state), RESEARCH_UNFILED_FOLDER_ID);
  // Archived trees show only in Archive, even while they keep a folder.
  assert.equal(researchTreePlace(tree("a", { archivedAt: 5 }), state), RESEARCH_ARCHIVE_FOLDER_ID);
  assert.deepEqual(workspaceResearchFolders(state, "ws").map((folder) => folder.id), ["f-read"]);
  assert.deepEqual(workspaceResearchFolders(state, null), []);
  assert.equal(researchPlaceName("f-read", state.folders), "Reading list");
  assert.equal(researchPlaceName(RESEARCH_DRAFTS_FOLDER_ID, state.folders), "Drafts");
  assert.equal(researchPlaceName(RESEARCH_ARCHIVE_FOLDER_ID, state.folders), "Archive");
  assert.equal(researchPlaceName("missing", state.folders), "Unfiled");
});

test("folder names are unique ignoring case, not reserved, not empty, and short", () => {
  const folders = workspaceResearchFolders(state, "ws");
  assert.equal(researchFolderNameError("  ", folders), "Enter a folder name.");
  assert.equal(researchFolderNameError("drafts", folders), "“drafts” is reserved. Choose another name.");
  assert.equal(researchFolderNameError("Home", folders), "“Home” is reserved. Choose another name.");
  assert.equal(researchFolderNameError("Unfiled", folders), "“Unfiled” is reserved. Choose another name.");
  assert.equal(
    researchFolderNameError("reading  LIST", folders),
    "A folder named “reading LIST” already exists.",
  );
  // Renaming a folder to its own name (in another case) is allowed.
  assert.equal(researchFolderNameError("READING list", folders, "f-read"), null);
  assert.equal(researchFolderNameError("Elsewhere", folders), null);
  assert.match(researchFolderNameError("x".repeat(41), folders) ?? "", /40 characters or fewer \(this is 41\)/);
  // Counted in code points like the backend: 40 emoji (80 UTF-16 units) fit.
  assert.equal(researchFolderNameError("📚".repeat(40), folders), null);
  assert.match(researchFolderNameError("📚".repeat(41), folders) ?? "", /\(this is 41\)/);
});

test("folder state edits: create, rename, delete, file, and collapse", () => {
  const created = researchFolderStateWithNewFolder(emptyResearchFolderState(), "  Later  ", "ws");
  assert.equal(created.folder.name, "Later");
  assert.match(created.folder.id, /^rfolder-/);
  assert.deepEqual(created.state.folders, [created.folder]);
  assert.equal(researchFolderStateRenamed(state, "f-read", " Papers ").folders[0].name, "Papers");

  const removed = researchFolderStateWithoutFolder(
    { ...state, collapsed: ["f-read", RESEARCH_ARCHIVE_FOLDER_ID] },
    "f-read",
  );
  assert.deepEqual(removed.folders.map((folder) => folder.id), ["f-other"]);
  assert.equal(removed.membership.a, undefined);
  assert.equal(removed.membership.b, RESEARCH_DRAFTS_FOLDER_ID);
  assert.deepEqual(removed.collapsed, [RESEARCH_ARCHIVE_FOLDER_ID]);

  assert.equal(researchFolderStateWithMembership(state, "d", "f-read").membership.d, "f-read");
  assert.equal(researchFolderStateWithMembership(state, "a", RESEARCH_UNFILED_FOLDER_ID).membership.a, undefined);
  // Archive is the tree's archived flag, so filing there clears no folder by itself.
  assert.equal(researchFolderStateWithMembership(state, "a", "f-read"), state);
  assert.equal(researchFolderStateWithMembership(state, "d", RESEARCH_UNFILED_FOLDER_ID), state);

  const collapsed = researchFolderStateWithCollapsed(state, RESEARCH_DRAFTS_FOLDER_ID, true);
  assert.deepEqual(collapsed.collapsed, [RESEARCH_DRAFTS_FOLDER_ID]);
  assert.equal(researchFolderStateWithCollapsed(collapsed, RESEARCH_DRAFTS_FOLDER_ID, true), collapsed);
  assert.deepEqual(researchFolderStateWithCollapsed(collapsed, RESEARCH_DRAFTS_FOLDER_ID, false).collapsed, []);
});

test("moving within or into a folder changes only the moved tree's flat position", () => {
  const flat = ["u1", "f1", "u2", "f2", "f3", "u3"];
  const members = ["f1", "f2", "f3"];
  // Reorder within the folder: f3 before f1.
  assert.deepEqual(researchTreeOrderAfterMove(flat, members, "f3", "f1"), ["u1", "f3", "f1", "u2", "f2", "u3"]);
  // Into the folder at its end: after the last member.
  assert.deepEqual(researchTreeOrderAfterMove(flat, members, "u1", null), ["f1", "u2", "f2", "f3", "u1", "u3"]);
  // Into an empty folder: the flat order is kept.
  assert.deepEqual(researchTreeOrderAfterMove(flat, [], "u2", null), flat);
  assert.deepEqual(reorderedIds(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(reorderedIds(["a", "b", "c"], "a", null), ["b", "c", "a"]);
  // Home's Unfiled list keeps the user's order; Archive keeps archive time.
  assert.equal(researchPlaceIsReorderable(RESEARCH_UNFILED_FOLDER_ID), true);
  assert.equal(researchPlaceIsReorderable(RESEARCH_ARCHIVE_FOLDER_ID), false);
  assert.equal(researchPlaceIsReorderable(RESEARCH_DRAFTS_FOLDER_ID), true);
  assert.equal(researchPlaceIsReorderable("f-read"), true);
});

test("a keyboard move steps one place up or down, and stops at the ends", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(stepReorderTarget(ids, "c", -1), { beforeId: "b" });
  assert.deepEqual(stepReorderTarget(ids, "b", 1), { beforeId: "d" });
  // Down from the second-to-last goes to the end.
  assert.deepEqual(stepReorderTarget(ids, "c", 1), { beforeId: null });
  assert.equal(stepReorderTarget(ids, "a", -1), null);
  assert.equal(stepReorderTarget(ids, "d", 1), null);
  assert.equal(stepReorderTarget(ids, "missing", 1), null);
  // Applied to the list, each move swaps the item with its neighbor.
  assert.deepEqual(reorderedIds(ids, "c", stepReorderTarget(ids, "c", -1)!.beforeId), ["a", "c", "b", "d"]);
  assert.deepEqual(reorderedIds(ids, "c", stepReorderTarget(ids, "c", 1)!.beforeId), ["a", "b", "d", "c"]);
});

test("a drop after a card goes before the card that follows it in the place", () => {
  const members = ["a", "b", "c"];
  assert.equal(researchDropBeforeId(members, "a", { afterId: "b" }), "c");
  assert.equal(researchDropBeforeId(members, "a", { afterId: "c" }), null);
  // The moved tree itself is skipped: after "a" (which follows "c") is the end.
  assert.equal(researchDropBeforeId(members, "b", { afterId: "a" }), "c");
  assert.equal(researchDropBeforeId(members, "c", { afterId: "b" }), null);
  assert.equal(researchDropBeforeId(members, "a", { beforeId: "c" }), "c");
  // Applied to the flat order, a positioned drop in Unfiled moves only the tree.
  const flat = ["u1", "f1", "u2", "u3"];
  assert.deepEqual(
    researchTreeOrderAfterMove(flat, ["u1", "u2", "u3"], "u3", researchDropBeforeId(["u1", "u2", "u3"], "u3", { beforeId: "u1" })),
    ["u3", "u1", "f1", "u2"],
  );
});

test("a local reorder touches only the workspace's own slots", () => {
  const trees = [tree("a"), tree("x", { workspaceId: "other" }), tree("b"), tree("c")];
  const next = treesWithWorkspaceOrder(trees, "ws", ["c", "a", "b"]);
  assert.deepEqual(next.map((entry) => entry.id), ["c", "x", "a", "b"]);
  // An order that doesn't cover the workspace (a tree arrived meanwhile) is ignored.
  assert.equal(treesWithWorkspaceOrder(trees, "ws", ["c", "a"]), trees);
});

test("monograms, card titles, and Move to targets", () => {
  assert.equal(researchFolderMonogram("reading list"), "R");
  assert.equal(researchFolderMonogram("  “Later”"), "L");
  assert.equal(researchFolderMonogram("—"), "?");
  assert.equal(researchCardTitle("Richard Ngo summary", "can you pull richard ngo's work"), "Richard Ngo summary");
  assert.equal(researchCardTitle("How do mods work?", "How do mods work?  "), null);
  assert.equal(researchCardTitle("  ", "Question"), null);
  assert.deepEqual(
    researchMoveTargets(workspaceResearchFolders(state, "ws")).map((target) => target.name),
    ["Unfiled", "Drafts", "Reading list", "Archive"],
  );
});

const root = {
  nodeId: "root", treeId: "t", parentNodeId: null, inline: false, prompt: "Root",
  adapter: "claude", status: "complete" as const, createdAt: 1,
};

test("starred children list follow-ups as text rows and branches with a level", () => {
  const children = researchFeedChildren({
    ...root,
    starred: [
      { ...root, nodeId: "f", parentNodeId: "root", inline: true, prompt: " Follow-up ", title: "Ignored", branchDepth: 0 },
      { ...root, nodeId: "b", parentNodeId: "root", prompt: "Branch prompt", title: "Branch title", branchDepth: 1, status: "running" },
      { ...root, nodeId: "bb", parentNodeId: "b", prompt: "Deeper", branchDepth: 4 },
      { ...root, nodeId: "fb", parentNodeId: "f", inline: false, prompt: "From the starred follow-up", branchDepth: 1 },
      { ...root, nodeId: "ub", parentNodeId: "unstarred", inline: false, prompt: "From another follow-up", branchDepth: 1 },
    ],
  });
  assert.deepEqual(
    children.map(({ nodeId, label, branch, indent, state }) => ({ nodeId, label, branch, indent, state })),
    [
      { nodeId: "f", label: "Follow-up", branch: false, indent: 1, state: "answered" },
      { nodeId: "b", label: "Branch title", branch: true, indent: 1, state: "running" },
      { nodeId: "bb", label: "Deeper", branch: true, indent: 2, state: "answered" },
      // A branch from a starred follow-up appears under it.
      { nodeId: "fb", label: "From the starred follow-up", branch: true, indent: 2, state: "answered" },
      { nodeId: "ub", label: "From another follow-up", branch: true, indent: 1, state: "answered" },
    ],
  );
});

test("node updates keep a root's starred list current, or ask for a refetch", () => {
  const items = [{
    ...root,
    starred: [{ ...root, nodeId: "f", parentNodeId: "root", inline: true, prompt: "Old", branchDepth: 0, starredAt: 5 }],
  }];
  const node = (id: string, starredAt: number | null, prompt = "New") =>
    researchNode({ id, treeId: "t", prompt, title: null, status: "running", starredAt });
  const updated = patchRecentActivityStarred(items, node("f", 5));
  assert.equal(updated.stale, false);
  assert.equal(updated.items[0].starred?.[0].prompt, "New");
  assert.equal(updated.items[0].starred?.[0].status, "running");
  const unstarred = patchRecentActivityStarred(items, node("f", null));
  assert.deepEqual(unstarred.items[0].starred, []);
  const starred = patchRecentActivityStarred(items, node("g", 9));
  assert.equal(starred.stale, true);
  assert.equal(starred.items, items);
  assert.equal(patchRecentActivityStarred(items, node("g", null)).items, items);
});

test("a folder in the Trash leaves the lists, keeps its membership, and frees its name", () => {
  const filed: ResearchFolderState = {
    folders: [
      { id: "f1", name: "Reading", workspaceId: "ws" },
      { id: "f2", name: "Later", workspaceId: "ws" },
    ],
    membership: { a: "f1", b: "f2" },
    collapsed: ["f1"],
    parents: {},
    collapsedGroups: [],
  };
  const trashed = researchFolderStateWithFolderTrashed(filed, "f1", 40);
  assert.equal(trashed.folders[0].trashedAt, 40);
  assert.deepEqual(trashed.membership, filed.membership);
  assert.deepEqual(trashed.collapsed, ["f1"]);
  assert.deepEqual(workspaceResearchFolders(trashed, "ws").map((folder) => folder.id), ["f2"]);
  // Its questions show as Unfiled until it is restored.
  assert.equal(researchTreePlace(tree("a"), trashed), RESEARCH_UNFILED_FOLDER_ID);
  assert.equal(researchTreePlace(tree("b"), trashed), "f2");
  assert.equal(
    researchFolderNameError("reading", workspaceResearchFolders(trashed, "ws")),
    null,
  );
  // Trashing again or an unknown folder changes nothing.
  assert.equal(researchFolderStateWithFolderTrashed(trashed, "f1", 40), trashed);
  assert.equal(researchFolderStateWithFolderTrashed(trashed, "missing", 40), trashed);

  const restored = researchFolderStateWithFolderTrashed(trashed, "f1", null);
  assert.deepEqual(restored, filed);
  assert.equal("trashedAt" in restored.folders[0], false);
  assert.equal(researchTreePlace(tree("a"), restored), "f1");
});

test("Trash is a place name and a reserved folder name", () => {
  assert.equal(researchPlaceName(RESEARCH_TRASH_FOLDER_ID, []), "Trash");
  assert.equal(researchFolderNameError(" trash ", []), "“trash” is reserved. Choose another name.");
});
