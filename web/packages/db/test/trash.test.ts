import type { ResearchFolderState } from "@session/shared";
import test from "ava";

import {
  feedItems,
  feeds,
  folders,
  highlights,
  nodes,
  trash,
  trees,
  workspaces,
} from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

function admit(fixture: Fixture, prompt: string, status: "complete" | "queued" = "complete") {
  return trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: prompt },
    agent: { model: "gemini-flash" },
    status,
  });
}

function state(partial: Partial<ResearchFolderState>): ResearchFolderState {
  return {
    folders: [],
    membership: {},
    collapsed: [],
    parents: {},
    collapsedGroups: [],
    ...partial,
  };
}

function sidebarIds(fixture: Fixture, includeArchived = false): string[] {
  return trees
    .summaries(fixture.db, fixture.userId, { workspaceId: fixture.workspaceId, includeArchived })
    .map((summary) => summary.id);
}

test("a tree in the Trash leaves every list and Restore puts it back where it was", (t) => {
  const fixture = createFixture(t);
  const first = admit(fixture, "First");
  const second = admit(fixture, "Second");
  const third = admit(fixture, "Third");
  t.deepEqual(sidebarIds(fixture), [third.tree.id, second.tree.id, first.tree.id]);
  t.truthy(feedItems.forTree(fixture.db, second.tree.id));

  const change = trash.trashTree(fixture.db, fixture.userId, second.tree.id);
  t.not(change.tree.trashedAt, null);
  t.deepEqual(change.changedTreeIds, [second.tree.id]);
  t.is(change.removedFeedItems.length, 1);
  // A private thread's feed row was its owner's alone to see.
  t.like(change.removedFeedItems[0], { public: false, ownerId: fixture.userId });
  t.deepEqual(sidebarIds(fixture, true), [third.tree.id, first.tree.id]);
  t.is(feedItems.forTree(fixture.db, second.tree.id), null);
  t.deepEqual(
    feeds
      .recentActivity(fixture.db, fixture.userId, { workspaceId: fixture.workspaceId, limit: 10 })
      .items.map((item) => item.query.nodeId),
    [third.tree.rootNodeId, first.tree.rootNodeId],
  );
  t.is(workspaces.treeCounts(fixture.db, fixture.userId).get(fixture.workspaceId), 2);
  const listed = trash.list(fixture.db, fixture.userId, fixture.workspaceId);
  t.deepEqual(
    listed.map((summary) => summary.id),
    [second.tree.id],
  );
  t.is(listed[0]?.completedCount, 1, "the Trash lists summaries with their counts");
  t.is(listed[0]?.trashedAt, change.tree.trashedAt);

  // Trashing again changes nothing.
  const again = trash.trashTree(fixture.db, fixture.userId, second.tree.id);
  t.deepEqual(again.changedTreeIds, []);
  t.is(again.tree.trashedAt, change.tree.trashedAt);

  // A new tree above it, and a reorder of the visible trees, while it is away.
  const fourth = admit(fixture, "Fourth");
  trees.reorder(fixture.db, fixture.userId, fixture.workspaceId, false, [
    fourth.tree.id,
    third.tree.id,
    first.tree.id,
  ]);

  const restored = trash.restoreTree(fixture.db, fixture.userId, second.tree.id);
  t.is(restored.tree.trashedAt, null);
  t.deepEqual(restored.changedTreeIds, [second.tree.id]);
  t.deepEqual(sidebarIds(fixture), [fourth.tree.id, third.tree.id, second.tree.id, first.tree.id]);
  t.truthy(feedItems.forTree(fixture.db, second.tree.id));
  t.deepEqual(trash.list(fixture.db, fixture.userId, fixture.workspaceId), []);
});

test("an archived tree returns to the Archive from the Trash", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Archived");
  trees.archive(fixture.db, fixture.userId, detail.tree.id);
  trash.trashTree(fixture.db, fixture.userId, detail.tree.id);
  t.deepEqual(sidebarIds(fixture, true), []);
  trash.restoreTree(fixture.db, fixture.userId, detail.tree.id);
  t.deepEqual(sidebarIds(fixture, true), [detail.tree.id]);
  t.not(trees.get(fixture.db, fixture.userId, detail.tree.id)?.archivedAt, null);
  t.is(feedItems.forTree(fixture.db, detail.tree.id), null, "archived trees stay off the feed");
});

test("a tree with an active run cannot be moved to the Trash", (t) => {
  const fixture = createFixture(t);
  const running = admit(fixture, "Running", "queued");
  t.throws(() => trash.trashTree(fixture.db, fixture.userId, running.tree.id), {
    message: /cannot move research to the Trash while it has active runs/,
  });
  nodes.setStatus(fixture.db, fixture.userId, running.tree.rootNodeId, "running");
  nodes.markInterrupted(fixture.db, fixture.userId, running.tree.rootNodeId);
  t.throws(() => trash.trashTree(fixture.db, fixture.userId, running.tree.id), {
    message: /active runs/,
  });
  t.is(trees.get(fixture.db, fixture.userId, running.tree.id)?.trashedAt, null);
});

test("edits to a tree in the Trash are refused until it is restored", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Root");
  const child = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    message: { text: "Child" },
  });
  nodes.setStatus(fixture.db, fixture.userId, child.id, "failed");
  trash.trashTree(fixture.db, fixture.userId, detail.tree.id);
  const refused = { message: /^restore this research from the Trash before changing it$/ };
  t.throws(() => trees.rename(fixture.db, fixture.userId, detail.tree.id, "New"), refused);
  t.throws(() => trees.archive(fixture.db, fixture.userId, detail.tree.id), refused);
  t.throws(() => trees.restore(fixture.db, fixture.userId, detail.tree.id), refused);
  t.throws(() => nodes.rename(fixture.db, fixture.userId, child.id, "New"), refused);
  t.throws(() => nodes.resetForRetry(fixture.db, fixture.userId, child.id), refused);
  t.throws(() => nodes.removeBranch(fixture.db, fixture.userId, child.id), refused);
  t.throws(
    () => highlights.removeMany(fixture.db, fixture.userId, detail.tree.rootNodeId, ["h"]),
    refused,
  );
  t.throws(
    () =>
      nodes.admitChild(fixture.db, fixture.userId, {
        parentNodeId: detail.tree.rootNodeId,
        message: { text: "Another" },
      }),
    { message: /in the Trash/ },
  );
  // Viewing is not an edit.
  t.notThrows(() => trees.markViewed(fixture.db, fixture.userId, detail.tree.id));

  trash.restoreTree(fixture.db, fixture.userId, detail.tree.id);
  t.is(trees.rename(fixture.db, fixture.userId, detail.tree.id, "New").title, "New");
  t.is(nodes.removeBranch(fixture.db, fixture.userId, child.id).removedNodeIds.length, 1);
});

test("a parent goes to the Trash, comes back and is deleted with the children listed under it", (t) => {
  const fixture = createFixture(t);
  const parent = admit(fixture, "Parent");
  const child = admit(fixture, "Child");
  const filedElsewhere = admit(fixture, "Elsewhere");
  const filing = state({
    folders: [{ id: "f1", name: "Reading", workspaceId: fixture.workspaceId }],
    membership: { [filedElsewhere.tree.id]: "f1" },
  });
  folders.setState(fixture.db, fixture.userId, fixture.workspaceId, filing);
  // Nested after it was filed: a write that leaves its membership as it was.
  folders.setState(fixture.db, fixture.userId, fixture.workspaceId, {
    ...filing,
    parents: { [child.tree.id]: parent.tree.id, [filedElsewhere.tree.id]: parent.tree.id },
  });
  t.deepEqual(
    folders.getState(fixture.db, fixture.userId, fixture.workspaceId).parents,
    { [child.tree.id]: parent.tree.id, [filedElsewhere.tree.id]: parent.tree.id },
    "a child filed in another place keeps its link and is listed on its own",
  );

  const trashed = trash.trashTree(fixture.db, fixture.userId, parent.tree.id);
  t.deepEqual(trashed.changedTreeIds.sort(), [parent.tree.id, child.tree.id].sort());
  t.deepEqual(
    trashed.children.map((tree) => tree.id),
    [child.tree.id],
  );
  t.deepEqual(sidebarIds(fixture), [filedElsewhere.tree.id]);

  const restored = trash.restoreTree(fixture.db, fixture.userId, parent.tree.id);
  t.deepEqual(
    restored.children.map((tree) => tree.id),
    [child.tree.id],
  );
  t.deepEqual(
    sidebarIds(fixture).sort(),
    [parent.tree.id, child.tree.id, filedElsewhere.tree.id].sort(),
  );

  // A child's own operations do not reach its parent.
  trash.trashTree(fixture.db, fixture.userId, child.tree.id);
  t.is(trees.get(fixture.db, fixture.userId, parent.tree.id)?.trashedAt, null);
  trash.restoreTree(fixture.db, fixture.userId, child.tree.id);

  const removed = trees.remove(fixture.db, fixture.userId, parent.tree.id);
  t.deepEqual(removed.treeIds.sort(), [parent.tree.id, child.tree.id].sort());
  t.false(removed.trashed);
  t.deepEqual(sidebarIds(fixture), [filedElsewhere.tree.id]);
  t.deepEqual(
    folders.getState(fixture.db, fixture.userId, fixture.workspaceId).parents,
    {},
    "a child listed elsewhere loses its deleted parent",
  );
});

test("archiving and unarchiving a parent takes the children listed under it", (t) => {
  const fixture = createFixture(t);
  const parent = admit(fixture, "Parent");
  const child = admit(fixture, "Child");
  folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({ parents: { [child.tree.id]: parent.tree.id } }),
  );
  const archived = trees.archiveGroup(fixture.db, fixture.userId, parent.tree.id);
  t.deepEqual(
    archived.children.map((tree) => tree.id),
    [child.tree.id],
  );
  t.is(archived.removedFeedItems.length, 2);
  t.deepEqual(sidebarIds(fixture), []);
  t.deepEqual(sidebarIds(fixture, true), [parent.tree.id, child.tree.id], "the parent is on top");
  const restored = trees.restoreGroup(fixture.db, fixture.userId, parent.tree.id);
  t.deepEqual(
    restored.children.map((tree) => tree.id),
    [child.tree.id],
  );
  t.deepEqual(sidebarIds(fixture), [parent.tree.id, child.tree.id]);
});

test("Delete removes a tree in or out of the Trash", (t) => {
  const fixture = createFixture(t);
  const kept = admit(fixture, "Kept");
  const trashed = admit(fixture, "Trashed");
  trash.trashTree(fixture.db, fixture.userId, trashed.tree.id);
  const removed = trees.remove(fixture.db, fixture.userId, trashed.tree.id);
  t.deepEqual(removed.treeIds, [trashed.tree.id]);
  t.true(removed.trashed);
  t.is(trees.get(fixture.db, fixture.userId, trashed.tree.id), null);
  t.deepEqual(trash.list(fixture.db, fixture.userId, fixture.workspaceId), []);
  t.deepEqual(sidebarIds(fixture), [kept.tree.id]);
});

test("emptying the Trash deletes the workspace's trashed trees and folders in one go", (t) => {
  const fixture = createFixture(t);
  const other = workspaces.create(fixture.db, fixture.userId, "Other");
  const stranger = addUser(fixture.db, "trash-stranger");
  const kept = admit(fixture, "Kept");
  const gone = admit(fixture, "Gone");
  const filed = admit(fixture, "Filed in a trashed folder");
  const elsewhere = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: other.id,
    message: { text: "Other workspace" },
    agent: { model: "gemini-flash" },
    status: "complete",
  });
  const theirs = trees.admitRoot(fixture.db, stranger.userId, {
    type: "exchange",
    workspaceId: stranger.workspaceId,
    message: { text: "Theirs" },
    agent: { model: "gemini-flash" },
    status: "complete",
  });
  folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({
      folders: [
        { id: "live", name: "Live", workspaceId: fixture.workspaceId },
        { id: "binned", name: "Binned", workspaceId: fixture.workspaceId, trashedAt: 5 },
      ],
      membership: { [filed.tree.id]: "binned" },
      collapsed: ["binned", "live"],
    }),
  );
  trash.trashTree(fixture.db, fixture.userId, gone.tree.id);
  trash.trashTree(fixture.db, fixture.userId, elsewhere.tree.id);
  trash.trashTree(fixture.db, stranger.userId, theirs.tree.id);

  const emptied = trash.empty(fixture.db, fixture.userId, fixture.workspaceId);
  t.deepEqual(emptied, {
    treeIds: [gone.tree.id],
    folderIds: ["binned"],
    leftTreeIds: [],
    departures: [],
  });
  t.is(trees.get(fixture.db, fixture.userId, gone.tree.id), null);
  t.truthy(trees.get(fixture.db, fixture.userId, elsewhere.tree.id), "other workspaces are kept");
  t.truthy(trees.get(fixture.db, stranger.userId, theirs.tree.id), "other people are kept");
  t.deepEqual(sidebarIds(fixture).sort(), [kept.tree.id, filed.tree.id].sort());
  const after = folders.getState(fixture.db, fixture.userId, fixture.workspaceId);
  t.deepEqual(
    after.folders.map((folder) => folder.id),
    ["live"],
  );
  t.deepEqual(after.membership, {}, "trees in the deleted folder are Unfiled");
  t.deepEqual(after.collapsed, ["live"]);
  t.deepEqual(trash.empty(fixture.db, fixture.userId, fixture.workspaceId), {
    treeIds: [],
    folderIds: [],
    leftTreeIds: [],
    departures: [],
  });
});

test("another person's tree cannot be moved to or out of the Trash", (t) => {
  const fixture = createFixture(t);
  const stranger = addUser(fixture.db, "trash-other");
  const detail = admit(fixture, "Mine");
  t.throws(() => trash.trashTree(fixture.db, stranger.userId, detail.tree.id), {
    message: /was not found$/,
  });
  trash.trashTree(fixture.db, fixture.userId, detail.tree.id);
  t.throws(() => trash.restoreTree(fixture.db, stranger.userId, detail.tree.id), {
    message: /was not found$/,
  });
  t.deepEqual(trash.list(fixture.db, stranger.userId, fixture.workspaceId), []);
});
