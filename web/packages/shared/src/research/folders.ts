// Research folders: a purely organizational grouping of research trees layered
// over the server's flat per-workspace order. The server stays the source of
// truth for which trees exist and their relative order, and now also stores the
// folder state itself (`02-domain-model-and-database.md` §5.11, `folders.*`);
// this module is the value layer both sides use — pure reducers that take a
// state and return the next one, plus the sidebar display model built from it.
//
// Ported from an earlier desktop `src/lib/researchFolders.ts` (its current
// version is `lib/researchFolders.ts` in this package) without its localStorage
// load/save and storage key, which have no equivalent here: `ResearchFolder`
// and `ResearchFolderState` are wire types in `wire/research.ts`. The web
// sidebar does not nest trees or collapse groups yet, so these reducers carry
// `parents` and `collapsedGroups` through unchanged.

import type { ResearchFolder, ResearchFolderState, ResearchTreeSummary } from "../wire/index.js";

export function emptyResearchFolderState(): ResearchFolderState {
  return { folders: [], membership: {}, collapsed: [], parents: {}, collapsedGroups: [] };
}

/** No folders, memberships, or collapsed flags — nothing to persist. */
export function isEmptyResearchFolderState(state: ResearchFolderState): boolean {
  return (
    state.folders.length === 0 &&
    Object.keys(state.membership).length === 0 &&
    state.collapsed.length === 0 &&
    Object.keys(state.parents).length === 0 &&
    state.collapsedGroups.length === 0
  );
}

/** Folder ids are generated client-side: a folder is an organizational value, not
 * a row the server has to allocate. `crypto` is optional in the platform
 * globals, so a time-and-random fallback keeps id generation total. */
function generateFolderId(): string {
  const uuid = crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `rfolder-${uuid}`;
}

export function createResearchFolder(
  state: ResearchFolderState,
  workspaceId: string,
  treeIds: string[],
  name = "New folder",
): { state: ResearchFolderState; folder: ResearchFolder } {
  const folder: ResearchFolder = { id: generateFolderId(), name, workspaceId };
  const membership = { ...state.membership };
  for (const treeId of treeIds) {
    membership[treeId] = folder.id;
  }
  return {
    state: {
      ...state,
      folders: [...state.folders, folder],
      membership,
    },
    folder,
  };
}

/** Moves trees into one folder. */
export function addTreesToResearchFolder(
  state: ResearchFolderState,
  folderId: string,
  treeIds: string[],
): ResearchFolderState {
  if (!state.folders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const membership = { ...state.membership };
  for (const treeId of treeIds) {
    membership[treeId] = folderId;
  }
  return {
    ...state,
    membership,
  };
}

export function setResearchFolderCollapsed(
  state: ResearchFolderState,
  folderId: string,
  collapsed: boolean,
): ResearchFolderState {
  if (!state.folders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const alreadyCollapsed = state.collapsed.includes(folderId);
  if (alreadyCollapsed === collapsed) {
    return state;
  }
  return {
    ...state,
    collapsed: collapsed
      ? [...state.collapsed, folderId]
      : state.collapsed.filter((id) => id !== folderId),
  };
}

export function renameResearchFolder(
  state: ResearchFolderState,
  folderId: string,
  name: string,
): ResearchFolderState {
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder)),
  };
}

/** Drops individual trees out of whatever folder holds them. Folder records
 * persist independently so deleting their last member leaves a reusable empty
 * folder. */
export function removeTreesFromResearchFolderMembership(
  state: ResearchFolderState,
  treeIds: string[],
): ResearchFolderState {
  const membership = { ...state.membership };
  let changed = false;
  for (const treeId of treeIds) {
    if (treeId in membership) {
      delete membership[treeId];
      changed = true;
    }
  }
  if (!changed) {
    return state;
  }
  return {
    ...state,
    membership,
  };
}

/** Drops the folder record and every membership pointing at it. The trees
 * themselves are untouched — they return to the flat list. */
export function dissolveResearchFolder(
  state: ResearchFolderState,
  folderId: string,
): ResearchFolderState {
  const membership: Record<string, string> = {};
  for (const [treeId, memberFolderId] of Object.entries(state.membership)) {
    if (memberFolderId !== folderId) {
      membership[treeId] = memberFolderId;
    }
  }
  return {
    ...state,
    folders: state.folders.filter((folder) => folder.id !== folderId),
    membership,
    collapsed: state.collapsed.filter((id) => id !== folderId),
  };
}

export function researchFolderMemberIds(state: ResearchFolderState, folderId: string): string[] {
  return Object.entries(state.membership)
    .filter(([, memberFolderId]) => memberFolderId === folderId)
    .map(([treeId]) => treeId);
}

// The sidebar's display model: the server's flat tree order regrouped into
// "units" — a plain tree, or a folder carrying every one of its member trees
// present in the list. A folder sits where its first member sat, and its
// members keep their relative order inside it.

export type ResearchSidebarUnit =
  | { kind: "tree"; tree: ResearchTreeSummary }
  | { kind: "folder"; folder: ResearchFolder; trees: ResearchTreeSummary[] };

export function researchSidebarUnitId(unit: ResearchSidebarUnit): string {
  return unit.kind === "tree" ? unit.tree.id : unit.folder.id;
}

/** The workspace a tree list is displaying, when the list determines it.
 * An empty folder has no member to place it beside, so it can only be shown
 * once the workspace is known. */
function inferWorkspaceId(trees: ResearchTreeSummary[]): string | null {
  const first = trees[0];
  if (!first) {
    return null;
  }
  return trees.every((tree) => tree.workspaceId === first.workspaceId) ? first.workspaceId : null;
}

export function buildResearchSidebarUnits(
  trees: ResearchTreeSummary[],
  state: ResearchFolderState,
  workspaceId?: string | null,
): ResearchSidebarUnit[] {
  const units: ResearchSidebarUnit[] = [];
  const folderUnits = new Map<string, Extract<ResearchSidebarUnit, { kind: "folder" }>>();
  for (const tree of trees) {
    const folderId = state.membership[tree.id];
    const folder = folderId
      ? state.folders.find((candidate) => candidate.id === folderId)
      : undefined;
    if (!folder) {
      units.push({ kind: "tree", tree });
      continue;
    }
    let unit = folderUnits.get(folder.id);
    if (!unit) {
      unit = { kind: "folder", folder, trees: [] };
      folderUnits.set(folder.id, unit);
      units.push(unit);
    }
    unit.trees.push(tree);
  }
  const displayedWorkspaceId = workspaceId ?? inferWorkspaceId(trees);
  if (displayedWorkspaceId) {
    const foldersWithStoredMembers = new Set(Object.values(state.membership));
    for (const folder of state.folders) {
      if (
        folder.workspaceId === displayedWorkspaceId &&
        !folderUnits.has(folder.id) &&
        !foldersWithStoredMembers.has(folder.id)
      ) {
        units.push({ kind: "folder", folder, trees: [] });
      }
    }
  }
  return units;
}

export function flattenResearchSidebarUnits(units: ResearchSidebarUnit[]): string[] {
  return units.flatMap((unit) =>
    unit.kind === "tree" ? [unit.tree.id] : unit.trees.map((tree) => tree.id),
  );
}

export function flattenVisibleResearchSidebarUnits(
  units: ResearchSidebarUnit[],
  state: ResearchFolderState,
): string[] {
  const collapsed = new Set(state.collapsed);
  return units.flatMap((unit) =>
    unit.kind === "tree" || !collapsed.has(unit.folder.id)
      ? unit.kind === "tree"
        ? [unit.tree.id]
        : unit.trees.map((tree) => tree.id)
      : [],
  );
}

export function visibleResearchTreeIds(
  trees: ResearchTreeSummary[],
  state: ResearchFolderState,
): string[] {
  return flattenVisibleResearchSidebarUnits(buildResearchSidebarUnits(trees, state), state);
}

/** Moves one unit (tree or whole folder) to a gap in the unit list. Returns
 * the reordered unit list, or null when the move is a no-op. */
export function moveResearchUnitToGap(
  units: ResearchSidebarUnit[],
  unitId: string,
  gapIndex: number,
): ResearchSidebarUnit[] | null {
  const fromIndex = units.findIndex((unit) => researchSidebarUnitId(unit) === unitId);
  const moved = fromIndex < 0 ? undefined : units[fromIndex];
  if (!moved || gapIndex < 0 || gapIndex > units.length) {
    return null;
  }
  if (gapIndex === fromIndex || gapIndex === fromIndex + 1) {
    return null;
  }
  const without = units.filter((unit) => researchSidebarUnitId(unit) !== unitId);
  const insertIndex = Math.max(
    0,
    Math.min(gapIndex > fromIndex ? gapIndex - 1 : gapIndex, without.length),
  );
  return [...without.slice(0, insertIndex), moved, ...without.slice(insertIndex)];
}

/** Moves one member to a gap inside its folder. Returns the unit list with
 * that folder's members reordered, or null when the move is a no-op. */
export function moveResearchFolderMemberToGap(
  units: ResearchSidebarUnit[],
  folderId: string,
  treeId: string,
  gapIndex: number,
): ResearchSidebarUnit[] | null {
  const unit = units.find(
    (candidate) => candidate.kind === "folder" && candidate.folder.id === folderId,
  );
  if (!unit || unit.kind !== "folder") {
    return null;
  }
  const memberIds = unit.trees.map((tree) => tree.id);
  const fromIndex = memberIds.indexOf(treeId);
  const moved = fromIndex < 0 ? undefined : unit.trees[fromIndex];
  if (!moved || gapIndex < 0 || gapIndex > memberIds.length) {
    return null;
  }
  if (gapIndex === fromIndex || gapIndex === fromIndex + 1) {
    return null;
  }
  const without = unit.trees.filter((tree) => tree.id !== treeId);
  const insertIndex = Math.max(
    0,
    Math.min(gapIndex > fromIndex ? gapIndex - 1 : gapIndex, without.length),
  );
  const reordered = [...without.slice(0, insertIndex), moved, ...without.slice(insertIndex)];
  return units.map((candidate) => (candidate === unit ? { ...unit, trees: reordered } : candidate));
}

/** A drop gap measured before an item joined a list needs to move one slot
 * right when the newly inserted item landed before that gap. */
export function translateResearchGapAfterInsertion(
  gapIndex: number,
  insertedIndex: number,
): number {
  return insertedIndex >= 0 && insertedIndex < gapIndex ? gapIndex + 1 : gapIndex;
}
