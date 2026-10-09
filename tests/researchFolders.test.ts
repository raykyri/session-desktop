import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyResearchFolderState,
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  reorderedIds,
  researchCardTitle,
  researchFeedChildren,
  researchFolderMonogram,
  researchFolderNameError,
  researchFolderStateRenamed,
  researchFolderStateWithCollapsed,
  researchFolderStateWithMembership,
  researchFolderStateWithNewFolder,
  researchFolderStateWithoutFolder,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreeOrderAfterMove,
  researchTreePlace,
  treesWithWorkspaceOrder,
  workspaceResearchFolders,
} from "../src/lib/researchFolders";
import { patchRecentActivityPromoted } from "../src/lib/activity";
import { researchMoveTargets } from "../src/components/research/ResearchMoveMenu";
import type { ResearchFolderState, ResearchNode, ResearchTreeSummary } from "../src/types";

function tree(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id, title: id, rootNodeId: `${id}-root`, kind: "run", workspaceId: "ws",
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
  starred: [],
  collapsed: [],
};

test("a tree's place: Archive by archivedAt, then its folder or Drafts, else Unfiled", () => {
  assert.equal(researchTreePlace(tree("a"), state), "f-read");
  assert.equal(researchTreePlace(tree("b"), state), RESEARCH_DRAFTS_FOLDER_ID);
  // A membership whose folder no longer exists reads as Unfiled.
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
  assert.equal(researchPlaceIsReorderable(RESEARCH_UNFILED_FOLDER_ID), false);
  assert.equal(researchPlaceIsReorderable(RESEARCH_ARCHIVE_FOLDER_ID), false);
  assert.equal(researchPlaceIsReorderable(RESEARCH_DRAFTS_FOLDER_ID), true);
  assert.equal(researchPlaceIsReorderable("f-read"), true);
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
    promoted: [
      { ...root, nodeId: "f", parentNodeId: "root", inline: true, prompt: " Follow-up ", title: "Ignored", branchDepth: 0 },
      { ...root, nodeId: "b", parentNodeId: "root", prompt: "Branch prompt", title: "Branch title", branchDepth: 1, status: "running" },
      { ...root, nodeId: "bb", parentNodeId: "b", prompt: "Deeper", branchDepth: 4 },
    ],
  });
  assert.deepEqual(
    children.map(({ nodeId, label, branch, level, running }) => ({ nodeId, label, branch, level, running })),
    [
      { nodeId: "f", label: "Follow-up", branch: false, level: 1, running: false },
      { nodeId: "b", label: "Branch title", branch: true, level: 1, running: true },
      { nodeId: "bb", label: "Deeper", branch: true, level: 2, running: false },
    ],
  );
});

test("node updates keep a root's starred list current, or ask for a refetch", () => {
  const items = [{
    ...root,
    promoted: [{ ...root, nodeId: "f", parentNodeId: "root", inline: true, prompt: "Old", branchDepth: 0, promotedAt: 5 }],
  }];
  const node = (id: string, promotedAt: number | null, prompt = "New") =>
    ({ id, treeId: "t", prompt, title: null, status: "running", promotedAt }) as unknown as ResearchNode & {
      promotedAt: number | null;
    };
  const updated = patchRecentActivityPromoted(items, node("f", 5));
  assert.equal(updated.stale, false);
  assert.equal(updated.items[0].promoted?.[0].prompt, "New");
  assert.equal(updated.items[0].promoted?.[0].status, "running");
  const unstarred = patchRecentActivityPromoted(items, node("f", null));
  assert.deepEqual(unstarred.items[0].promoted, []);
  const starred = patchRecentActivityPromoted(items, node("g", 9));
  assert.equal(starred.stale, true);
  assert.equal(starred.items, items);
  assert.equal(patchRecentActivityPromoted(items, node("g", null)).items, items);
});
