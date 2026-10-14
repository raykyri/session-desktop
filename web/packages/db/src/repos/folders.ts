// Sidebar folders (`docs/02-domain-model-and-database.md` §5.11).
//
// The client owns the folder state as a value and sends the whole thing back;
// the server normalizes it structurally and stores it, last write wins. The
// desktop's `normalize_research_folder_state` (`research.rs:94`) is reproduced
// for the parts the web sidebar edits today: dedupe folders, drop membership
// and collapsed entries pointing at folders that are not in the state. It
// deliberately does not prune by tree existence.
//
// The state is stored across `folders`, `tree_folder_membership`,
// `collapsed_places`, `trees.parent_tree_id` and `collapsed_groups`. `getState`
// reads all five; `setState` writes the first three and leaves `parents` and
// `collapsedGroups` as they are, since nothing on the web edits them yet.
//
// Membership rows reference `trees` and `folders`. Entries naming nonexistent
// records are omitted during normalization because they cannot satisfy the
// foreign key constraints used for tree deletion (`02` §3.2).

import type { ResearchFolder, ResearchFolderState } from "@session/shared";
import { RESEARCH_DRAFTS_FOLDER_ID } from "@session/shared/lib/researchFolders";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import {
  collapsedGroups,
  collapsedPlaces,
  folders,
  treeFolderMembership,
} from "../schema/folders.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

/** A Home tray that is not a folder: `system:drafts`, `system:archive`, … */
function isSystemPlace(id: string): boolean {
  return id.startsWith("system:");
}

/** Structural normalization, independent of which trees exist. The drafts
 * tray is a valid membership target alongside the state's folders. */
export function normalizeFolderState(state: ResearchFolderState): ResearchFolderState {
  const seenFolders = new Set<string>();
  const folderList: ResearchFolder[] = [];
  for (const folder of state.folders) {
    if (!seenFolders.has(folder.id)) {
      seenFolders.add(folder.id);
      folderList.push(folder);
    }
  }
  const membership: Record<string, string> = {};
  for (const [treeId, folderId] of Object.entries(state.membership)) {
    if (seenFolders.has(folderId) || folderId === RESEARCH_DRAFTS_FOLDER_ID) {
      membership[treeId] = folderId;
    }
  }
  const seenCollapsed = new Set<string>();
  const collapsed = state.collapsed.filter(
    (id) =>
      (seenFolders.has(id) || isSystemPlace(id)) && !seenCollapsed.has(id) && seenCollapsed.add(id),
  );
  return {
    folders: folderList,
    membership,
    collapsed,
    parents: state.parents,
    collapsedGroups: state.collapsedGroups,
  };
}

export function getState(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
): ResearchFolderState {
  const folderRows = db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, userId), eq(folders.workspaceId, workspaceId)))
    .orderBy(asc(folders.position), asc(folders.id))
    .all();
  const treeRows = db
    .select({ id: trees.id, parentTreeId: trees.parentTreeId })
    .from(trees)
    .where(and(eq(trees.ownerId, userId), eq(trees.workspaceId, workspaceId)))
    .all();
  const treeIds = treeRows.map((row) => row.id);
  const membership: Record<string, string> = {};
  const parents: Record<string, string> = {};
  const groups: string[] = [];
  if (treeIds.length > 0) {
    for (const row of db
      .select()
      .from(treeFolderMembership)
      .where(inArray(treeFolderMembership.treeId, treeIds))
      .all()) {
      const place =
        row.folderId ?? (row.systemPlace === "drafts" ? RESEARCH_DRAFTS_FOLDER_ID : null);
      if (place !== null) {
        membership[row.treeId] = place;
      }
    }
    for (const row of treeRows) {
      if (row.parentTreeId !== null) {
        parents[row.id] = row.parentTreeId;
      }
    }
    for (const row of db
      .select({ treeId: collapsedGroups.treeId })
      .from(collapsedGroups)
      .where(and(eq(collapsedGroups.userId, userId), inArray(collapsedGroups.treeId, treeIds)))
      .orderBy(asc(collapsedGroups.treeId))
      .all()) {
      groups.push(row.treeId);
    }
  }
  const collapsed = db
    .select({ placeId: collapsedPlaces.placeId })
    .from(collapsedPlaces)
    .where(and(eq(collapsedPlaces.userId, userId), eq(collapsedPlaces.workspaceId, workspaceId)))
    .orderBy(asc(collapsedPlaces.placeId))
    .all()
    .map((row) => row.placeId);
  return {
    folders: folderRows.map((row) => ({
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      trashedAt: row.trashedAt,
    })),
    membership,
    collapsed,
    parents,
    collapsedGroups: groups,
  };
}

/**
 * Replaces the workspace's folders, memberships and collapsed trays, and
 * returns the stored state for the client to adopt. Entries naming a tree or
 * folder outside this workspace are removed before storage.
 */
export function setState(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  state: ResearchFolderState,
): ResearchFolderState {
  const normalized = normalizeFolderState(state);
  return transact(db, (tx) => {
    const knownTreeIds = new Set(
      tx
        .select({ id: trees.id })
        .from(trees)
        .where(and(eq(trees.ownerId, userId), eq(trees.workspaceId, workspaceId)))
        .all()
        .map((row) => row.id),
    );
    const existingFolders = new Map(
      tx
        .select({ id: folders.id, trashedAt: folders.trashedAt })
        .from(folders)
        .where(and(eq(folders.ownerId, userId), eq(folders.workspaceId, workspaceId)))
        .all()
        .map((row) => [row.id, row.trashedAt]),
    );
    const candidateFolders = normalized.folders.filter(
      (folder) => folder.workspaceId === workspaceId || folder.workspaceId === "",
    );
    // Validate that folder IDs do not conflict with existing folders belonging to another account or workspace.
    const claimedElsewhere = new Set(
      candidateFolders.length === 0
        ? []
        : tx
            .select({ id: folders.id })
            .from(folders)
            .where(
              inArray(
                folders.id,
                candidateFolders.map((folder) => folder.id),
              ),
            )
            .all()
            .map((row) => row.id)
            .filter((id) => !existingFolders.has(id)),
    );
    const keptFolders = candidateFolders.filter((folder) => !claimedElsewhere.has(folder.id));
    const keptFolderIds = new Set(keptFolders.map((folder) => folder.id));
    const at = now();
    // Delete folder membership associations prior to deleting the folder record.
    for (const treeId of knownTreeIds) {
      tx.delete(treeFolderMembership).where(eq(treeFolderMembership.treeId, treeId)).run();
    }
    for (const folderId of existingFolders.keys()) {
      if (!keptFolderIds.has(folderId)) {
        tx.delete(folders).where(eq(folders.id, folderId)).run();
      }
    }
    keptFolders.forEach((folder, position) => {
      // The Trash is changed by its own procedures (2.4), so a stored
      // `trashed_at` survives a state written without it.
      const trashedAt = folder.trashedAt ?? existingFolders.get(folder.id) ?? null;
      tx.insert(folders)
        .values({
          id: folder.id,
          ownerId: userId,
          workspaceId,
          name: folder.name,
          position,
          createdAt: at,
          trashedAt,
        })
        .onConflictDoUpdate({
          target: folders.id,
          set: { name: folder.name, position, workspaceId, trashedAt },
        })
        .run();
    });
    for (const [treeId, place] of Object.entries(normalized.membership)) {
      if (!knownTreeIds.has(treeId)) {
        continue;
      }
      if (place === RESEARCH_DRAFTS_FOLDER_ID) {
        tx.insert(treeFolderMembership)
          .values({ treeId, folderId: null, systemPlace: "drafts" })
          .run();
      } else if (keptFolderIds.has(place)) {
        tx.insert(treeFolderMembership)
          .values({ treeId, folderId: place, systemPlace: null })
          .run();
      }
    }
    tx.delete(collapsedPlaces)
      .where(and(eq(collapsedPlaces.userId, userId), eq(collapsedPlaces.workspaceId, workspaceId)))
      .run();
    for (const placeId of new Set(normalized.collapsed)) {
      if (keptFolderIds.has(placeId) || isSystemPlace(placeId)) {
        tx.insert(collapsedPlaces).values({ userId, workspaceId, placeId }).run();
      }
    }
    return getState(tx, userId, workspaceId);
  });
}
