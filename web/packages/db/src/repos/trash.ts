// The Trash: trees and folders with `trashed_at` set (the desktop's
// `trash_research_tree`, `restore_research_tree_from_trash`,
// `list_research_trash` and `empty_research_trash`, `state.rs`). Every other
// list leaves them out (`trees.summaries`, `feeds.recentQueries`, the
// highlight feed, the Home feed through `feedgen`), and user edits to a tree
// in the Trash are refused (`access.rejectTrashed`).
//
// Moving a tree to the Trash deletes nothing: its nodes, snapshots, folder
// membership, parent, archive state and sidebar position stay, so Restore
// puts it back where it was. A parent goes to the Trash and comes back with
// the children listed under it (`trees.groupChildren`).
//
// A folder enters and leaves the Trash through `folders.setState`, as on the
// desktop, where the client sets the folder's `trashedAt`. Emptying the Trash
// deletes both kinds.
//
// The Trash is per person and private. The owner's Trash is the thread's
// `trashed_at` (and `trashed_by`), which hides the thread from everyone else
// until the owner restores it. A member's Trash is `trashed_at` on their
// member row: the thread is listed only in their Trash and nothing changes
// for anyone else. Emptying the Trash deletes the owner's threads and makes
// the member leave the shared ones.

import type { ResearchTree, ResearchTreeSummary } from "@session/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { treeMembers } from "../schema/collaboration.js";
import { collapsedPlaces, folders } from "../schema/folders.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import type { FeedItemDescriptor } from "./feedItems.js";
import { activeRun } from "./subtrees.js";
import {
  deleteTreeRows,
  feedItemsOf,
  groupChildren,
  leave,
  requireMember,
  requireTreeRow,
  roleOf,
  setMemberFlag,
  summaries,
  trashRow,
  untrashRow,
} from "./trees.js";

/** The desktop's refusal (`state.rs`, `trash_research_tree`). */
const TRASH_ACTIVE_RUN_ERROR =
  "cannot move research to the Trash while it has active runs; stop them or wait for them to finish";

/** A Trash operation on a tree and the children that went with it.
 * `changedTreeIds` are the trees whose state it changed; a tree already
 * where the operation puts it is reported but not changed. */
export interface TrashChange {
  tree: ResearchTree;
  children: ResearchTree[];
  changedTreeIds: string[];
  /** The Home feed rows the operation deleted, for `feed.item.removed`. */
  removedFeedItems: FeedItemDescriptor[];
}

/** What `empty` deleted. */
export interface EmptiedTrash {
  /** The trees gone from the caller's Trash: deleted, or left. */
  treeIds: string[];
  folderIds: string[];
  /** Of `treeIds`, the shared threads the caller left. */
  leftTreeIds: string[];
}

/** Trees among `treeIds` with a run the server still owns: queued, running,
 * or interrupted and about to resume (`subtrees.activeRun`). An interrupted
 * run the server stopped resuming does not hold the tree. */
function activeTreeIds(db: SessionDatabase, treeIds: readonly string[]): Set<string> {
  if (treeIds.length === 0) {
    return new Set();
  }
  return new Set(
    db
      .selectDistinct({ treeId: nodes.treeId })
      .from(nodes)
      .where(and(inArray(nodes.treeId, [...treeIds]), activeRun()))
      .all()
      .map((row) => row.treeId),
  );
}

/** The workspace's trees in the Trash, most recently trashed first, with the
 * sidebar's counts and flags. */
export function list(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
): ResearchTreeSummary[] {
  return summaries(db, userId, { workspaceId, trashed: true });
}

/**
 * Moves a tree and the children listed under it to the Trash. Refused while
 * any of them has an active run, as on the desktop; nothing moves then.
 */
export function trashTree(db: SessionDatabase, userId: string, treeId: string): TrashChange {
  return transact(db, (tx) => {
    if (roleOf(tx, userId, treeId) !== "owner") {
      // A member's Trash is theirs alone and does not wait for runs.
      const access = requireMember(tx, userId, treeId);
      const changed = access.member?.trashedAt === null;
      return {
        tree: setMemberFlag(tx, userId, treeId, changed ? { trashedAt: now() } : {}),
        children: [],
        changedTreeIds: changed ? [treeId] : [],
        removedFeedItems: [],
      };
    }
    const row = requireTreeRow(tx, userId, treeId);
    const children = groupChildren(tx, row);
    const group = [row, ...children];
    if (
      activeTreeIds(
        tx,
        group.map((member) => member.id),
      ).size > 0
    ) {
      throw new Error(TRASH_ACTIVE_RUN_ERROR);
    }
    const at = now();
    const changed = group.filter((member) => member.trashedAt === null);
    const removedFeedItems = feedItemsOf(tx, changed);
    return {
      tree: trashRow(tx, userId, row, at),
      children: children.map((child) => trashRow(tx, userId, child, at)),
      changedTreeIds: changed.map((member) => member.id),
      removedFeedItems,
    };
  });
}

/** Takes a tree and its children in the Trash out of it. Each returns to its
 * folder (or Drafts, Unfiled or the Archive) at its old position. */
export function restoreTree(db: SessionDatabase, userId: string, treeId: string): TrashChange {
  return transact(db, (tx) => {
    if (roleOf(tx, userId, treeId) !== "owner") {
      const access = requireMember(tx, userId, treeId);
      const changed = access.member?.trashedAt !== null;
      return {
        tree: setMemberFlag(tx, userId, treeId, { trashedAt: null }),
        children: [],
        changedTreeIds: changed ? [treeId] : [],
        removedFeedItems: [],
      };
    }
    const row = requireTreeRow(tx, userId, treeId);
    const children = groupChildren(tx, row);
    const changedTreeIds = [row, ...children]
      .filter((member) => member.trashedAt !== null)
      .map((member) => member.id);
    return {
      tree: untrashRow(tx, userId, row),
      children: children.map((child) => untrashRow(tx, userId, child)),
      changedTreeIds,
      removedFeedItems: [],
    };
  });
}

/**
 * Deletes every tree and every folder in the workspace's Trash in one
 * transaction. A tree with an active run cannot be in the Trash; one that has
 * one anyway is left there and not reported. Deleting a folder deletes the
 * memberships that file trees in it (those trees become Unfiled) and the
 * collapsed flags that name it.
 */
export function empty(db: SessionDatabase, userId: string, workspaceId: string): EmptiedTrash {
  return transact(db, (tx) => {
    const trashedTreeIds = tx
      .select({ id: trees.id })
      .from(trees)
      .where(
        and(
          eq(trees.ownerId, userId),
          eq(trees.workspaceId, workspaceId),
          isNotNull(trees.trashedAt),
        ),
      )
      .all()
      .map((row) => row.id);
    const active = activeTreeIds(tx, trashedTreeIds);
    const treeIds = trashedTreeIds.filter((id) => !active.has(id)).sort();
    deleteTreeRows(tx, treeIds);
    // Shared threads in the caller's own Trash: they leave them.
    const leftTreeIds = tx
      .select({ treeId: treeMembers.treeId })
      .from(treeMembers)
      .where(and(eq(treeMembers.userId, userId), isNotNull(treeMembers.trashedAt)))
      .all()
      .map((row) => row.treeId)
      .sort();
    for (const treeId of leftTreeIds) {
      leave(tx, userId, treeId);
    }
    const folderIds = tx
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.ownerId, userId),
          eq(folders.workspaceId, workspaceId),
          isNotNull(folders.trashedAt),
        ),
      )
      .all()
      .map((row) => row.id)
      .sort();
    if (folderIds.length > 0) {
      tx.delete(folders).where(inArray(folders.id, folderIds)).run();
      tx.delete(collapsedPlaces)
        .where(
          and(
            eq(collapsedPlaces.workspaceId, workspaceId),
            inArray(collapsedPlaces.placeId, folderIds),
          ),
        )
        .run();
    }
    return { treeIds: [...treeIds, ...leftTreeIds], folderIds, leftTreeIds };
  });
}
