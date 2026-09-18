// Sidebar folders (`docs/02-domain-model-and-database.md` §5.11).
//
// The client owns the folder state as a value and sends the whole thing back;
// the server normalizes it structurally and stores it, last write wins. The
// desktop's `normalize_research_folder_state` (`research.rs:94`) is reproduced
// exactly: dedupe folders, drop membership and collapsed entries pointing at
// folders that are not in the state, dedupe stars. It deliberately does not
// prune by tree existence.
//
// One departure follows from the schema rather than the rule: membership and
// stars are stored as rows keyed to `trees` and `folders`, so an entry naming
// a tree or folder that does not exist has nowhere to live and is dropped on
// the way in. `02` §3.2 already relies on that foreign key for tree deletion.
//
// `starred` is a rank, not a flag: `ResearchFolderState.starred` is one
// ordered sequence interleaving tree ids and folder ids, and two booleans
// cannot round-trip an interleaving.

import type { ResearchFolder, ResearchFolderState } from "@session/shared";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { folders, treeFolderMembership } from "../schema/folders.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

/** Structural normalization, independent of which trees exist. */
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
    if (seenFolders.has(folderId)) {
      membership[treeId] = folderId;
    }
  }
  const seenStars = new Set<string>();
  const starred = state.starred.filter((id) => !seenStars.has(id) && seenStars.add(id));
  const seenCollapsed = new Set<string>();
  const collapsed = state.collapsed.filter(
    (id) => seenFolders.has(id) && !seenCollapsed.has(id) && seenCollapsed.add(id),
  );
  return { folders: folderList, membership, starred, collapsed };
}

export function getState(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
): ResearchFolderState {
  const folderRows = db
    .select()
    .from(folders)
    .where(and(eq(folders.userId, userId), eq(folders.workspaceId, workspaceId)))
    .orderBy(asc(folders.position), asc(folders.id))
    .all();
  const treeRows = db
    .select({ id: trees.id, starred: trees.starred })
    .from(trees)
    .where(and(eq(trees.userId, userId), eq(trees.workspaceId, workspaceId)))
    .all();
  const treeIds = treeRows.map((row) => row.id);
  const membership: Record<string, string> = {};
  if (treeIds.length > 0) {
    for (const row of db
      .select()
      .from(treeFolderMembership)
      .where(inArray(treeFolderMembership.treeId, treeIds))
      .all()) {
      membership[row.treeId] = row.folderId;
    }
  }
  const ranked = [
    ...folderRows.map((row) => ({ id: row.id, rank: row.starred })),
    ...treeRows.map((row) => ({ id: row.id, rank: row.starred })),
  ]
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
  return {
    folders: folderRows.map((row) => ({
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
    })),
    membership,
    starred: ranked.map((entry) => entry.id),
    collapsed: folderRows.filter((row) => row.collapsed).map((row) => row.id),
  };
}

/**
 * Replaces the workspace's folder state and returns what was stored, which the
 * client adopts. Entries naming a tree or folder outside this workspace are
 * dropped, so the returned value is the truth rather than an echo.
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
        .where(and(eq(trees.userId, userId), eq(trees.workspaceId, workspaceId)))
        .all()
        .map((row) => row.id),
    );
    const existingFolderIds = new Set(
      tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.userId, userId), eq(folders.workspaceId, workspaceId)))
        .all()
        .map((row) => row.id),
    );
    const candidateFolders = normalized.folders.filter(
      (folder) => folder.workspaceId === workspaceId || folder.workspaceId === "",
    );
    // A folder id that already names a row somewhere else — another account or
    // another workspace — is not this caller's to claim: the upsert below would
    // move that row here rather than create one.
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
            .filter((id) => !existingFolderIds.has(id)),
    );
    const keptFolders = candidateFolders.filter((folder) => !claimedElsewhere.has(folder.id));
    const keptFolderIds = new Set(keptFolders.map((folder) => folder.id));
    const collapsed = new Set(normalized.collapsed.filter((id) => keptFolderIds.has(id)));
    const starRank = new Map<string, number>();
    normalized.starred.forEach((id, index) => {
      if (keptFolderIds.has(id) || knownTreeIds.has(id)) {
        starRank.set(id, index + 1);
      }
    });
    const at = now();
    // Membership first: a folder about to be deleted must not still hold rows.
    for (const treeId of knownTreeIds) {
      tx.delete(treeFolderMembership).where(eq(treeFolderMembership.treeId, treeId)).run();
    }
    for (const folderId of existingFolderIds) {
      if (!keptFolderIds.has(folderId)) {
        tx.delete(folders).where(eq(folders.id, folderId)).run();
      }
    }
    keptFolders.forEach((folder, position) => {
      const values = {
        id: folder.id,
        userId,
        workspaceId,
        name: folder.name,
        collapsed: collapsed.has(folder.id),
        starred: starRank.get(folder.id) ?? 0,
        position,
        createdAt: at,
      };
      tx.insert(folders)
        .values(values)
        .onConflictDoUpdate({
          target: folders.id,
          set: {
            name: values.name,
            collapsed: values.collapsed,
            starred: values.starred,
            position,
            workspaceId,
          },
        })
        .run();
    });
    for (const [treeId, folderId] of Object.entries(normalized.membership)) {
      if (knownTreeIds.has(treeId) && keptFolderIds.has(folderId)) {
        tx.insert(treeFolderMembership).values({ treeId, folderId }).run();
      }
    }
    for (const treeId of knownTreeIds) {
      tx.update(trees)
        .set({ starred: starRank.get(treeId) ?? 0 })
        .where(eq(trees.id, treeId))
        .run();
    }
    return getState(tx, userId, workspaceId);
  });
}
