import test from "ava";

import {
  addTreesToResearchFolder,
  buildResearchSidebarLists,
  createResearchFolder,
  dissolveResearchFolder,
  emptyResearchFolderState,
  isEmptyResearchFolderState,
  moveResearchFolderMemberToGap,
  moveResearchUnitToGap,
  removeTreesFromResearchFolderMembership,
  removeTreesFromResearchFolders,
  researchFolderMemberIds,
  researchSidebarUnitId,
  setResearchFolderCollapsed,
  toggleResearchStar,
  translateResearchGapAfterInsertion,
  visibleResearchTreeIds,
} from "../src/research/folders.js";
import type { ResearchFolderState, ResearchTreeSummary } from "../src/types/research.js";

function tree(id: string): ResearchTreeSummary {
  return {
    id,
    title: id,
    rootNodeId: `${id}-root`,
    kind: "run",
    workspaceId: "workspace-1",
    runningCount: 0,
    failedCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    updatedAt: 0,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  };
}

function state(): ResearchFolderState {
  return {
    folders: [
      { id: "folder-a", name: "A", workspaceId: "workspace-1" },
      { id: "folder-b", name: "B", workspaceId: "workspace-1" },
    ],
    membership: { one: "folder-a", two: "folder-a", three: "folder-b" },
    starred: ["one", "folder-a"],
    collapsed: ["folder-a"],
  };
}

test("an empty folder state has nothing to persist", (t) => {
  t.is(isEmptyResearchFolderState(emptyResearchFolderState()), true);
  t.is(isEmptyResearchFolderState(state()), false);
});

test("collapse state toggles idempotently", (t) => {
  const initial = state();
  t.is(setResearchFolderCollapsed(initial, "folder-a", true), initial);
  const expanded = setResearchFolderCollapsed(initial, "folder-a", false);
  t.deepEqual(expanded.collapsed, []);
  t.is(setResearchFolderCollapsed(expanded, "missing", true), expanded);
});

test("collapsed folders hide members from the visible research order", (t) => {
  const initial = state();
  t.deepEqual(
    visibleResearchTreeIds([tree("one"), tree("two"), tree("three"), tree("four")], initial),
    ["one", "three", "four"],
  );
});

test("unfoldering preserves item stars and the emptied folder", (t) => {
  const initial = state();
  const next = removeTreesFromResearchFolderMembership(initial, ["one", "two"]);
  t.deepEqual(next.membership, { three: "folder-b" });
  t.deepEqual(
    next.folders.map((folder) => folder.id),
    ["folder-a", "folder-b"],
  );
  t.deepEqual(next.starred, ["one", "folder-a"]);
  t.deepEqual(next.collapsed, ["folder-a"]);
  t.is(removeTreesFromResearchFolderMembership(next, ["one"]), next);
});

test("deleting trees drops their membership and their stars", (t) => {
  const initial = state();
  const next = removeTreesFromResearchFolders(initial, ["one"]);
  t.deepEqual(next.membership, { two: "folder-a", three: "folder-b" });
  t.deepEqual(next.starred, ["folder-a"]);
  t.is(removeTreesFromResearchFolders(next, ["missing"]), next);
});

test("dissolving a folder returns its trees to the flat list", (t) => {
  const next = dissolveResearchFolder(state(), "folder-a");
  t.deepEqual(
    next.folders.map((folder) => folder.id),
    ["folder-b"],
  );
  t.deepEqual(next.membership, { three: "folder-b" });
  t.deepEqual(next.starred, ["one"]);
  t.deepEqual(next.collapsed, []);
});

test("folder membership is queryable by folder", (t) => {
  t.deepEqual(researchFolderMemberIds(state(), "folder-a"), ["one", "two"]);
  t.deepEqual(researchFolderMemberIds(state(), "missing"), []);
});

test("starring appends to the stored order and unstarring removes it", (t) => {
  const starred = toggleResearchStar(state(), "three");
  t.deepEqual(starred.starred, ["one", "folder-a", "three"]);
  t.deepEqual(toggleResearchStar(starred, "one").starred, ["folder-a", "three"]);
});

test("moving the last member to another folder preserves the empty source folder", (t) => {
  const initial = state();
  const next = addTreesToResearchFolder(initial, "folder-a", ["three"]);
  t.deepEqual(next.membership, {
    one: "folder-a",
    two: "folder-a",
    three: "folder-a",
  });
  t.deepEqual(
    next.folders.map((folder) => folder.id),
    ["folder-a", "folder-b"],
  );
  t.is(addTreesToResearchFolder(initial, "missing", ["three"]), initial);
});

test("moving trees into a folder clears their individual stars", (t) => {
  const initial = state();
  const next = addTreesToResearchFolder(initial, "folder-b", ["one"]);
  t.is(next.membership.one, "folder-b");
  t.deepEqual(next.starred, ["folder-a"]);
});

test("creating a folder moves its trees out of the individual starred list", (t) => {
  const created = createResearchFolder(state(), "workspace-1", ["one"], "Created");
  t.is(created.state.membership.one, created.folder.id);
  t.deepEqual(created.state.starred, ["folder-a"]);
  t.regex(created.folder.id, /^rfolder-/);
});

test("empty folders are created and displayed in their workspace", (t) => {
  const created = createResearchFolder(emptyResearchFolderState(), "workspace-1", [], "Empty");
  const lists = buildResearchSidebarLists([], created.state, "workspace-1");
  t.is(created.folder.name, "Empty");
  t.deepEqual(lists.main, [{ kind: "folder", folder: created.folder, trees: [] }]);
  t.deepEqual(buildResearchSidebarLists([], created.state, "workspace-2"), {
    starred: [],
    main: [],
  });
});

test("starred trees and folders are pinned above the main list", (t) => {
  const lists = buildResearchSidebarLists(
    [tree("one"), tree("two"), tree("three"), tree("four")],
    state(),
  );
  t.deepEqual(lists.starred.map(researchSidebarUnitId), ["one", "folder-a"]);
  // `one` is starred individually, so folder A carries only its other member.
  t.deepEqual(
    lists.starred.map((unit) => (unit.kind === "folder" ? unit.trees.map((item) => item.id) : [])),
    [[], ["two"]],
  );
  t.deepEqual(lists.main.map(researchSidebarUnitId), ["folder-b", "four"]);
});

test("units and folder members move to pointer gaps or report a no-op", (t) => {
  const units = buildResearchSidebarLists(
    [tree("one"), tree("two"), tree("three"), tree("four")],
    state(),
  ).main;
  t.deepEqual(moveResearchUnitToGap(units, "four", 0)?.map(researchSidebarUnitId), [
    "four",
    "folder-b",
  ]);
  t.is(moveResearchUnitToGap(units, "four", 2), null);
  t.is(moveResearchUnitToGap(units, "missing", 0), null);

  const withMembers = buildResearchSidebarLists([tree("one"), tree("two")], {
    ...state(),
    starred: [],
  }).main;
  const reordered = moveResearchFolderMemberToGap(withMembers, "folder-a", "two", 0);
  const folderUnit = reordered?.[0];
  t.deepEqual(folderUnit?.kind === "folder" ? folderUnit.trees.map((item) => item.id) : [], [
    "two",
    "one",
  ]);
  t.is(moveResearchFolderMemberToGap(withMembers, "folder-a", "two", 2), null);
  t.is(moveResearchFolderMemberToGap(withMembers, "missing", "two", 0), null);
});

test("pre-insertion drop gaps account for the inserted item's temporary slot", (t) => {
  t.is(translateResearchGapAfterInsertion(2, 0), 3);
  t.is(translateResearchGapAfterInsertion(2, 1), 3);
  t.is(translateResearchGapAfterInsertion(2, 2), 2);
  t.is(translateResearchGapAfterInsertion(0, 2), 0);
  t.is(translateResearchGapAfterInsertion(2, -1), 2);
});
