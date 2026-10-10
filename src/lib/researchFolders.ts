import type {
  RecentResearchQuery,
  ResearchFolder,
  ResearchFolderState,
  ResearchTreeSummary,
} from "../types";
import { isActiveResearchStatus } from "./researchThreads";

// Places a research tree can be filed in. Unfiled and Archive are derived
// (no membership, and `archivedAt`); Drafts is a membership value with no
// folder record; every other place is a user folder id. The system ids also
// key the collapsed state of their Home trays.
export const RESEARCH_DRAFTS_FOLDER_ID = "system:drafts";
export const RESEARCH_ARCHIVE_FOLDER_ID = "system:archive";
export const RESEARCH_UNFILED_FOLDER_ID = "system:unfiled";

const RESEARCH_FOLDER_NAME_MAX_LENGTH = 40;
const RESERVED_FOLDER_NAMES = ["home", "unfiled", "drafts", "archive", "bookmarks", "highlights"];

export function emptyResearchFolderState(): ResearchFolderState {
  return { folders: [], membership: {}, starred: [], collapsed: [] };
}

/** Only Drafts and user folders keep a manual order: Unfiled follows the
 * feed's chronology and Archive lists the most recently archived first. */
export function researchPlaceIsReorderable(place: string): boolean {
  return place !== RESEARCH_UNFILED_FOLDER_ID && place !== RESEARCH_ARCHIVE_FOLDER_ID;
}

export function workspaceResearchFolders(
  state: ResearchFolderState,
  workspaceId: string | null,
): ResearchFolder[] {
  return workspaceId ? state.folders.filter((folder) => folder.workspaceId === workspaceId) : [];
}

export function researchPlaceName(place: string, folders: ResearchFolder[]): string {
  if (place === RESEARCH_DRAFTS_FOLDER_ID) return "Drafts";
  if (place === RESEARCH_ARCHIVE_FOLDER_ID) return "Archive";
  if (place === RESEARCH_UNFILED_FOLDER_ID) return "Unfiled";
  return folders.find((folder) => folder.id === place)?.name ?? "Unfiled";
}

/** Where a tree is listed. An archived tree shows only in Archive even when
 * it keeps a folder membership; a membership whose folder no longer exists
 * reads as Unfiled. */
export function researchTreePlace(
  tree: Pick<ResearchTreeSummary, "id" | "archivedAt">,
  state: ResearchFolderState,
): string {
  if (tree.archivedAt != null) return RESEARCH_ARCHIVE_FOLDER_ID;
  const member = state.membership[tree.id];
  if (member === RESEARCH_DRAFTS_FOLDER_ID) return member;
  if (member && state.folders.some((folder) => folder.id === member)) return member;
  return RESEARCH_UNFILED_FOLDER_ID;
}

/** Folder names are trimmed with inner whitespace collapsed. */
export function normalizeResearchFolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** The inline error for a proposed folder name, or null when it can be used.
 * Names are unique per workspace ignoring case, and the system place names
 * are reserved. */
export function researchFolderNameError(
  rawName: string,
  folders: ResearchFolder[],
  renamingId: string | null = null,
): string | null {
  const name = normalizeResearchFolderName(rawName);
  if (!name) return "Enter a folder name.";
  // Counted in code points, as the backend counts `chars()`: an emoji is one.
  const length = Array.from(name).length;
  if (length > RESEARCH_FOLDER_NAME_MAX_LENGTH) {
    return `Use ${RESEARCH_FOLDER_NAME_MAX_LENGTH} characters or fewer (this is ${length}).`;
  }
  if (RESERVED_FOLDER_NAMES.includes(name.toLowerCase())) {
    return `“${name}” is reserved. Choose another name.`;
  }
  if (
    folders.some(
      (folder) => folder.id !== renamingId && folder.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return `A folder named “${name}” already exists.`;
  }
  return null;
}

/** The strip shows a user folder as the first letter or digit of its name. */
export function researchFolderMonogram(name: string): string {
  const match = name.trim().match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "?";
}

export function newResearchFolderId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `rfolder-${uuid}`;
}

export function researchFolderStateWithNewFolder(
  state: ResearchFolderState,
  name: string,
  workspaceId: string,
  id: string = newResearchFolderId(),
): { state: ResearchFolderState; folder: ResearchFolder } {
  const folder = {
    id,
    name: normalizeResearchFolderName(name),
    workspaceId,
  };
  return { state: { ...state, folders: [...state.folders, folder] }, folder };
}

export function researchFolderStateRenamed(
  state: ResearchFolderState,
  folderId: string,
  name: string,
): ResearchFolderState {
  return {
    ...state,
    folders: state.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: normalizeResearchFolderName(name) } : folder,
    ),
  };
}

/** Removes a folder; its trees fall back to Unfiled. */
export function researchFolderStateWithoutFolder(
  state: ResearchFolderState,
  folderId: string,
): ResearchFolderState {
  return {
    folders: state.folders.filter((folder) => folder.id !== folderId),
    membership: Object.fromEntries(
      Object.entries(state.membership).filter(([, member]) => member !== folderId),
    ),
    starred: state.starred.filter((id) => id !== folderId),
    collapsed: state.collapsed.filter((id) => id !== folderId),
  };
}

/** Files a tree in a folder or Drafts; Unfiled (and Archive, which is the
 * tree's archived flag) clear the membership. */
export function researchFolderStateWithMembership(
  state: ResearchFolderState,
  treeId: string,
  place: string,
): ResearchFolderState {
  const filed = place !== RESEARCH_UNFILED_FOLDER_ID && place !== RESEARCH_ARCHIVE_FOLDER_ID;
  if (filed ? state.membership[treeId] === place : !(treeId in state.membership)) return state;
  const membership = { ...state.membership };
  if (filed) membership[treeId] = place;
  else delete membership[treeId];
  return { ...state, membership };
}

export function researchFolderStateWithCollapsed(
  state: ResearchFolderState,
  place: string,
  collapsed: boolean,
): ResearchFolderState {
  if (state.collapsed.includes(place) === collapsed) return state;
  return {
    ...state,
    collapsed: collapsed
      ? [...state.collapsed, place]
      : state.collapsed.filter((id) => id !== place),
  };
}

/** The new flat tree order after filing `treeId` before `beforeId`, or at
 * the end of the folder whose current members (in display order) are
 * `memberIds`. A folder's order is the flat order filtered to its members,
 * so only the moved tree changes position. */
export function researchTreeOrderAfterMove(
  flatIds: string[],
  memberIds: string[],
  treeId: string,
  beforeId: string | null,
): string[] {
  const rest = flatIds.filter((id) => id !== treeId);
  if (beforeId && beforeId !== treeId) {
    const index = rest.indexOf(beforeId);
    if (index >= 0) return [...rest.slice(0, index), treeId, ...rest.slice(index)];
  }
  const others = memberIds.filter((id) => id !== treeId);
  if (others.length === 0) return flatIds;
  const lastIndex = rest.indexOf(others[others.length - 1]);
  return lastIndex < 0
    ? flatIds
    : [...rest.slice(0, lastIndex + 1), treeId, ...rest.slice(lastIndex + 1)];
}

/** Moves one id in a list before another, or to the end. */
export function reorderedIds(ids: string[], movedId: string, beforeId: string | null): string[] {
  const rest = ids.filter((id) => id !== movedId);
  const index = beforeId ? rest.indexOf(beforeId) : -1;
  return index < 0 ? [...rest, movedId] : [...rest.slice(0, index), movedId, ...rest.slice(index)];
}

const normalizedText = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Show the title above the question unless its normalized prefix matches
 * the start of the question. */
export function researchCardTitle(title: string | null | undefined, question: string): string | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  return normalizedText(question).startsWith(normalizedText(trimmed).slice(0, 60))
    ? null
    : trimmed;
}

export interface ResearchFeedChild {
  nodeId: string;
  treeId: string;
  label: string;
  /** A non-inline child: opens as a branch pair with its ancestors. */
  branch: boolean;
  /** Indent level: 1 under the question; 2 for a branch under another
   * child (a branch of a branch, or a branch from a starred follow-up). */
  level: number;
  running: boolean;
  query: RecentResearchQuery;
}

/** Starred follow-ups and branches listed under a root question, in tree
 * order. Only follow-ups of the root conversation and branch heads can be
 * starred, so a branch head's parent is the message it was asked from. */
export function researchFeedChildren(root: RecentResearchQuery): ResearchFeedChild[] {
  const starred = (root.promoted ?? []).filter((child) => child.nodeId !== root.nodeId);
  const starredFollowUps = new Set(
    starred.filter((child) => child.inline).map((child) => child.nodeId),
  );
  return starred.map((child) => {
    const depth = child.branchDepth ?? (child.inline ? 0 : 1);
    const underChild =
      !child.inline &&
      (depth > 1 || (child.parentNodeId != null && starredFollowUps.has(child.parentNodeId)));
    return {
      nodeId: child.nodeId,
      treeId: child.treeId,
      label: (child.inline ? child.prompt : (child.title?.trim() || child.prompt)).trim(),
      branch: !child.inline,
      level: underChild ? 2 : 1,
      running: isActiveResearchStatus(child.status),
      query: child,
    };
  });
}

/** Puts one workspace's trees in `orderedIds` order, in the slots they
 * already occupy, leaving other workspaces' trees where they are. */
export function treesWithWorkspaceOrder(
  trees: ResearchTreeSummary[],
  workspaceId: string,
  orderedIds: string[],
): ResearchTreeSummary[] {
  const byId = new Map(trees.map((tree) => [tree.id, tree]));
  const queue = orderedIds.flatMap((id) => {
    const tree = byId.get(id);
    return tree && tree.workspaceId === workspaceId ? [tree] : [];
  });
  const count = trees.filter((tree) => tree.workspaceId === workspaceId).length;
  if (queue.length === 0 || queue.length !== count) return trees;
  let index = 0;
  let changed = false;
  const next = trees.map((tree) => {
    if (tree.workspaceId !== workspaceId) return tree;
    const replacement = queue[index++];
    if (replacement !== tree) changed = true;
    return replacement;
  });
  return changed ? next : trees;
}
