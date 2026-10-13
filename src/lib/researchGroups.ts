import type { ResearchFolderState, ResearchNodeType } from "../types";
import type { ResearchRowState } from "./researchRowGlyph";
import { researchTreeOrderAfterMove } from "./researchFolders";

// Nesting in Home: a question or a document (the parent) lists other items
// (its children) under its card. One level deep: a parent is never a child.
// The link is `ResearchFolderState.parents` (child → parent). A child keeps
// its own membership, kept equal to its parent's, and its own position in the
// flat tree order: a group's children are listed in that order. A child whose
// parent is not a top-level item of the same list (archived, in the Trash,
// filed elsewhere) is listed on its own.

/** Questions and documents can hold children; notes, link posts and X posts
 * cannot. */
export function researchTreeHoldsChildren(type: ResearchNodeType | undefined): boolean {
  return type === "exchange" || type === "document";
}

interface ResearchTreeGroup<T> {
  tree: T;
  /** The children listed under it, in the list's order. */
  children: T[];
}

/** The parent `id` is listed under in a list of `ids`, or null when it is
 * listed on its own. */
function listedParent(
  id: string,
  ids: ReadonlySet<string>,
  parents: Readonly<Record<string, string>>,
): string | null {
  const parent = parents[id];
  return parent && parent !== id && ids.has(parent) && parents[parent] === undefined ? parent : null;
}

/** A list's trees (in its order) as top-level items, each with the children
 * listed under it. */
export function researchTreeGroups<T extends { id: string }>(
  trees: readonly T[],
  parents: Readonly<Record<string, string>>,
): ResearchTreeGroup<T>[] {
  const ids = new Set(trees.map((tree) => tree.id));
  const groups = new Map<string, ResearchTreeGroup<T>>();
  const top: ResearchTreeGroup<T>[] = [];
  for (const tree of trees) {
    if (listedParent(tree.id, ids, parents)) continue;
    const group = { tree, children: [] as T[] };
    groups.set(tree.id, group);
    top.push(group);
  }
  for (const tree of trees) {
    const parent = listedParent(tree.id, ids, parents);
    if (parent) groups.get(parent)?.children.push(tree);
  }
  return top;
}

/** The ids of `parentId`'s children among `trees`, in their order. */
export function researchChildIds(
  parentId: string,
  trees: readonly { id: string }[],
  parents: Readonly<Record<string, string>>,
): string[] {
  return trees.filter((tree) => tree.id !== parentId && parents[tree.id] === parentId).map((tree) => tree.id);
}

/** Lists `childId` under `parentId`, or with null on its own. A child takes
 * its parent's membership (Unfiled when the parent has none) and loses any
 * collapsed flag of its own. */
export function researchFolderStateWithParent(
  state: ResearchFolderState,
  childId: string,
  parentId: string | null,
): ResearchFolderState {
  if (parentId === null) {
    if (!(childId in state.parents)) return state;
    const parents = { ...state.parents };
    delete parents[childId];
    return { ...state, parents };
  }
  const membership = { ...state.membership };
  const parentMember = state.membership[parentId];
  if (parentMember) membership[childId] = parentMember;
  else delete membership[childId];
  return {
    ...state,
    membership,
    parents: { ...state.parents, [childId]: parentId },
    collapsedGroups: state.collapsedGroups.filter((id) => id !== childId),
  };
}

export function researchFolderStateWithGroupCollapsed(
  state: ResearchFolderState,
  parentId: string,
  collapsed: boolean,
): ResearchFolderState {
  if (state.collapsedGroups.includes(parentId) === collapsed) return state;
  return {
    ...state,
    collapsedGroups: collapsed
      ? [...state.collapsedGroups, parentId]
      : state.collapsedGroups.filter((id) => id !== parentId),
  };
}

/** The part of a card the pointer is over during a drag. A card that can
 * hold children has top and bottom edges a quarter of its height (at least
 * 8px, at most 14px) that insert before and after it; the rest nests. Other
 * cards split at the midpoint. */
export function researchCardDropZone(
  height: number,
  offsetY: number,
  holdsChildren: boolean,
): "before" | "after" | "nest" {
  if (!holdsChildren) return offsetY > height / 2 ? "after" : "before";
  const edge = Math.min(14, Math.max(8, height * 0.25));
  if (offsetY < edge) return "before";
  if (offsetY > height - edge) return "after";
  return "nest";
}

/** Why `treeId` cannot be listed under `parentId` (or within its group), or
 * null when it can. */
export function researchNestRefusal(
  treeId: string,
  parentId: string,
  parents: Readonly<Record<string, string>>,
): string | null {
  if (treeId === parentId) return "Can’t nest an item under itself.";
  if (parents[parentId] === treeId) return "Can’t move a group into itself.";
  return null;
}

/** The new flat order after listing `childId` under a parent before
 * `beforeId` (a current child), or at the end of the group for null. The
 * group is `[parentId, ...siblingIds]` in flat order. */
export function researchOrderAfterNest(
  flatIds: string[],
  parentId: string,
  siblingIds: readonly string[],
  childId: string,
  beforeId: string | null,
): string[] {
  return researchTreeOrderAfterMove(
    flatIds,
    [parentId, ...siblingIds.filter((id) => id !== childId)],
    childId,
    beforeId,
  );
}

/** The new flat order after Move out: the child goes right after its former
 * group, before the top-level item that follows the parent in `topLevelIds`
 * (the list's top-level items in order), or at the end of the list, after
 * the group's other children (`siblingIds`). */
export function researchOrderAfterMoveOut(
  flatIds: string[],
  topLevelIds: readonly string[],
  parentId: string,
  childId: string,
  siblingIds: readonly string[] = [],
): string[] {
  const index = topLevelIds.indexOf(parentId);
  const beforeId = index < 0 ? null : (topLevelIds[index + 1] ?? null);
  const position = new Map(flatIds.map((id, at) => [id, at]));
  const members = [...topLevelIds, ...siblingIds].sort(
    (left, right) => (position.get(left) ?? -1) - (position.get(right) ?? -1),
  );
  return researchTreeOrderAfterMove(flatIds, members, childId, beforeId);
}

/** Running, failed and updated counts for a collapsed group's line. */
export function researchGroupSummary(
  children: readonly { state: ResearchRowState; unread: boolean }[],
): { running: number; failed: number; updated: number } {
  const summary = { running: 0, failed: 0, updated: 0 };
  for (const child of children) {
    if (child.state === "running" || child.state === "queued") summary.running += 1;
    else if (child.state === "failed") summary.failed += 1;
    else if (child.unread && child.state === "answered") summary.updated += 1;
  }
  return summary;
}

/** "1 item", "3 items". */
export function researchItemCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

/** "1 child", "3 children". */
export function researchChildCount(count: number): string {
  return `${count} ${count === 1 ? "child" : "children"}`;
}

/** Make child of… lists the eligible items of a list (`ids`, its top-level
 * items in order). A long list keeps the `limit` nearest to `anchorId` (the
 * item, or a child's parent), in list order. */
export function researchNestCandidates(
  ids: readonly string[],
  anchorId: string,
  eligible: (id: string) => boolean,
  limit = 30,
): string[] {
  const candidates = ids.filter(eligible);
  if (candidates.length <= limit) return candidates;
  const at = Math.max(0, ids.indexOf(anchorId));
  const distance = new Map(ids.map((id, index) => [id, Math.abs(index - at)]));
  const nearest = new Set(
    [...candidates]
      .sort((left, right) => (distance.get(left) ?? 0) - (distance.get(right) ?? 0))
      .slice(0, limit),
  );
  return candidates.filter((id) => nearest.has(id));
}
