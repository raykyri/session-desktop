// Sidebar folders and nesting (`docs/02-domain-model-and-database.md` §5.11).
//
// The client owns the desktop's `ResearchFolderState` as a value and sends the
// whole of it back; the server normalizes and validates it as the desktop's
// `set_research_folders` does (`state.rs`), stores it, and returns the stored
// state for the client to adopt. Last write wins. The desktop keeps one state
// for every workspace; the web keeps one per (person, workspace).
//
// The state is stored across five places:
// - `folders`: the folder records, `trashedAt` included (a folder enters and
//   leaves the Trash through this write, as on the desktop);
// - `tree_folder_membership`: `membership`, a folder id or `system:drafts`;
// - `collapsed_places`: `collapsed`, per person;
// - `trees.parent_tree_id`: `parents`;
// - `collapsed_groups`: `collapsedGroups`, per person.
//
// Entries naming a tree outside this person's workspace are dropped before
// storage: the rows that hold them reference `trees`.

import type { ResearchFolder, ResearchFolderState } from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "@session/shared/lib/researchFolders";
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

/** Home trays whose collapsed flag `collapsed` holds next to folder ids
 * (`RESEARCH_SYSTEM_FOLDER_IDS`, `research.rs`). */
const SYSTEM_PLACE_IDS: ReadonlySet<string> = new Set([
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
]);
const SYSTEM_FOLDER_ID_PREFIX = "system:";
/** Names of the sidebar's places, lowercase (`RESERVED_RESEARCH_FOLDER_NAMES`,
 * `research.rs`; `RESERVED_FOLDER_NAMES`, `lib/researchFolders.ts`). */
const RESERVED_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "home",
  "unfiled",
  "drafts",
  "archive",
  "trash",
  "highlights",
]);
/** In code points, as the desktop counts `chars()`. */
const FOLDER_NAME_MAX_CHARS = 40;

/**
 * Keeps nesting one level deep: drops a link from a tree to itself and a link
 * whose parent is itself a child (the deeper link goes; the parent's own link
 * stays), and dedupes the collapsed groups (`normalize_research_groups`).
 */
function normalizeGroups(
  parents: Readonly<Record<string, string>>,
  groups: readonly string[],
): { parents: Record<string, string>; collapsedGroups: string[] } {
  const direct = Object.entries(parents).filter(([child, parent]) => child !== parent);
  const children = new Set(direct.map(([child]) => child));
  const nestedParents = new Set(
    direct.map(([, parent]) => parent).filter((parent) => children.has(parent)),
  );
  return {
    parents: Object.fromEntries(direct.filter(([, parent]) => !nestedParents.has(parent))),
    collapsedGroups: [...new Set(groups)],
  };
}

/**
 * Structural normalization, independent of which trees exist
 * (`normalize_research_folder_state`, `research.rs`): dedupe folder ids
 * (the first record wins), drop membership naming a folder not in the state
 * (`system:drafts` excepted), drop collapsed entries naming neither a folder
 * in the state nor a system tray, and keep nesting one level deep.
 */
export function normalizeFolderState(state: ResearchFolderState): ResearchFolderState {
  const folderIds = new Set<string>();
  const folderList: ResearchFolder[] = [];
  for (const folder of state.folders) {
    if (!folderIds.has(folder.id)) {
      folderIds.add(folder.id);
      folderList.push(folder);
    }
  }
  const membership = Object.fromEntries(
    Object.entries(state.membership).filter(
      ([, place]) => folderIds.has(place) || place === RESEARCH_DRAFTS_FOLDER_ID,
    ),
  );
  const collapsed = [
    ...new Set(state.collapsed.filter((id) => folderIds.has(id) || SYSTEM_PLACE_IDS.has(id))),
  ];
  return {
    folders: folderList,
    membership,
    collapsed,
    ...normalizeGroups(state.parents, state.collapsedGroups),
  };
}

/**
 * Trims folder names and refuses empty, overlong, reserved and duplicate
 * names, and ids in the `system:` namespace (`validate_research_folders`,
 * `research.rs`). Reserved and duplicate checks compare lowercase forms;
 * duplicates count only folders outside the Trash, since a folder in the
 * Trash does not hold its name. A folder whose id and trimmed name match
 * `current` is not checked again, so a stored state stays writable, except
 * that restoring it from the Trash fails while another folder has its name.
 * Returns the folders with trimmed names.
 */
export function validateFolders(
  next: readonly ResearchFolder[],
  current: readonly ResearchFolder[],
): ResearchFolder[] {
  const previous = new Map(
    current.map((folder) => [
      folder.id,
      { name: folder.name.trim(), trashed: folder.trashedAt != null },
    ]),
  );
  const trimmed = next.map((folder) => ({ ...folder, name: folder.name.trim() }));
  const key = (folder: ResearchFolder): string =>
    `${folder.workspaceId}\u0000${folder.name.toLowerCase()}`;
  const nameCounts = new Map<string, number>();
  for (const folder of trimmed) {
    if (folder.trashedAt == null) {
      nameCounts.set(key(folder), (nameCounts.get(key(folder)) ?? 0) + 1);
    }
  }
  const duplicate = (folder: ResearchFolder): boolean =>
    folder.trashedAt == null && (nameCounts.get(key(folder)) ?? 0) > 1;
  for (const folder of trimmed) {
    const before = previous.get(folder.id);
    if (before !== undefined && before.name === folder.name) {
      const restored = before.trashed && folder.trashedAt == null;
      if (restored && duplicate(folder)) {
        throw new Error(`A folder named "${folder.name}" already exists.`);
      }
      continue;
    }
    if (folder.id.trim() === "") {
      throw new Error("Folder ids cannot be empty.");
    }
    if (folder.id.startsWith(SYSTEM_FOLDER_ID_PREFIX)) {
      throw new Error(`The folder id "${folder.id}" is reserved.`);
    }
    if (folder.name === "") {
      throw new Error("Folder names cannot be empty.");
    }
    if (Array.from(folder.name).length > FOLDER_NAME_MAX_CHARS) {
      throw new Error(`Folder names can be at most ${FOLDER_NAME_MAX_CHARS} characters.`);
    }
    if (RESERVED_FOLDER_NAMES.has(folder.name.toLowerCase())) {
      throw new Error(`The name "${folder.name}" is reserved.`);
    }
    if (duplicate(folder)) {
      throw new Error(`A folder named "${folder.name}" already exists.`);
    }
  }
  return trimmed;
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
    .orderBy(asc(trees.id))
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
      .orderBy(asc(treeFolderMembership.treeId))
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

/** JSON with object keys sorted, for comparing two states. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : inner,
  );
}

/** The stored state after a write, and whether the write changed it. */
export interface FolderStateWrite {
  state: ResearchFolderState;
  changed: boolean;
}

/**
 * Replaces the workspace's folder state and returns the stored state for the
 * client to adopt.
 *
 * Beyond the desktop's normalization and validation:
 * - folders of another workspace, and ids already used by another person's or
 *   workspace's folder, are dropped;
 * - membership, parents and collapsed groups naming a tree outside this
 *   workspace are dropped, and nesting is normalized again afterwards;
 * - a child whose membership this write changes to a place other than its
 *   parent's leaves the group (filing a child elsewhere moves it out, as
 *   the desktop's `moveTree` does). Nesting sets the child's membership to its
 *   parent's in the same write (`researchFolderStateWithParent`), so it is
 *   unaffected, and so is a child whose membership the write leaves as it was.
 */
export function replaceState(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  state: ResearchFolderState,
): FolderStateWrite {
  const normalized = normalizeFolderState(state);
  return transact(db, (tx) => {
    const current = getState(tx, userId, workspaceId);
    const knownTreeIds = new Set(
      tx
        .select({ id: trees.id })
        .from(trees)
        .where(and(eq(trees.ownerId, userId), eq(trees.workspaceId, workspaceId)))
        .all()
        .map((row) => row.id),
    );
    const existingFolderIds = new Set(current.folders.map((folder) => folder.id));
    const candidateFolders = normalized.folders
      .filter((folder) => folder.workspaceId === workspaceId || folder.workspaceId === "")
      .map((folder) => ({ ...folder, workspaceId }));
    // A folder id belonging to another account or workspace is not taken over.
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
    const keptFolders = validateFolders(
      candidateFolders.filter((folder) => !claimedElsewhere.has(folder.id)),
      current.folders,
    );
    const keptFolderIds = new Set(keptFolders.map((folder) => folder.id));

    const membership: Record<string, string> = {};
    for (const [treeId, place] of Object.entries(normalized.membership)) {
      if (
        knownTreeIds.has(treeId) &&
        (place === RESEARCH_DRAFTS_FOLDER_ID || keptFolderIds.has(place))
      ) {
        membership[treeId] = place;
      }
    }
    const grouping = normalizeGroups(
      Object.fromEntries(
        Object.entries(normalized.parents).filter(
          ([child, parent]) => knownTreeIds.has(child) && knownTreeIds.has(parent),
        ),
      ),
      normalized.collapsedGroups.filter((id) => knownTreeIds.has(id)),
    );
    const parents = grouping.parents;
    for (const [child, parent] of Object.entries(parents)) {
      const place = membership[child] ?? null;
      if (place !== (current.membership[child] ?? null) && place !== (membership[parent] ?? null)) {
        delete parents[child];
      }
    }
    const collapsed = normalized.collapsed.filter(
      (id) => keptFolderIds.has(id) || SYSTEM_PLACE_IDS.has(id),
    );

    const at = now();
    // Memberships go before the folders they reference.
    if (knownTreeIds.size > 0) {
      tx.delete(treeFolderMembership)
        .where(inArray(treeFolderMembership.treeId, [...knownTreeIds]))
        .run();
    }
    for (const folderId of existingFolderIds) {
      if (!keptFolderIds.has(folderId)) {
        tx.delete(folders).where(eq(folders.id, folderId)).run();
      }
    }
    keptFolders.forEach((folder, position) => {
      const trashedAt = folder.trashedAt ?? null;
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
          set: { name: folder.name, position, trashedAt },
        })
        .run();
    });
    for (const [treeId, place] of Object.entries(membership)) {
      tx.insert(treeFolderMembership)
        .values(
          place === RESEARCH_DRAFTS_FOLDER_ID
            ? { treeId, folderId: null, systemPlace: "drafts" }
            : { treeId, folderId: place, systemPlace: null },
        )
        .run();
    }
    for (const treeId of knownTreeIds) {
      const parentTreeId = parents[treeId] ?? null;
      if (parentTreeId !== (current.parents[treeId] ?? null)) {
        tx.update(trees).set({ parentTreeId }).where(eq(trees.id, treeId)).run();
      }
    }
    tx.delete(collapsedPlaces)
      .where(and(eq(collapsedPlaces.userId, userId), eq(collapsedPlaces.workspaceId, workspaceId)))
      .run();
    for (const placeId of collapsed) {
      tx.insert(collapsedPlaces).values({ userId, workspaceId, placeId }).run();
    }
    if (knownTreeIds.size > 0) {
      tx.delete(collapsedGroups)
        .where(
          and(
            eq(collapsedGroups.userId, userId),
            inArray(collapsedGroups.treeId, [...knownTreeIds]),
          ),
        )
        .run();
    }
    for (const treeId of grouping.collapsedGroups) {
      tx.insert(collapsedGroups).values({ userId, treeId }).run();
    }
    const stored = getState(tx, userId, workspaceId);
    return { state: stored, changed: canonical(stored) !== canonical(current) };
  });
}

/** `replaceState`, answering with the stored state alone. */
export function setState(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  state: ResearchFolderState,
): ResearchFolderState {
  return replaceState(db, userId, workspaceId, state).state;
}
