import type { ResearchFolderState, ResearchNodeType } from "../types";
import type { ResearchRowState } from "./researchRowGlyph";
import { researchTreeOrderAfterMove } from "./researchFolders";

// Nesting in Home: a question, a document or a post (the parent) lists other
// items (its children) under its card. One level deep: a parent is never a
// child.
// The link is `ResearchFolderState.parents` (child → parent). A child keeps
// its own membership, kept equal to its parent's, and its own position in the
// flat tree order: a group's children are listed in that order. A child whose
// parent is not a top-level item of the same list (archived, in the Trash,
// filed elsewhere) is listed on its own.

/** Questions, documents and posts (text notes, link posts and X posts) can
 * hold children; a tree whose type isn't known cannot. */
export function researchTreeHoldsChildren(type: ResearchNodeType | undefined): boolean {
  return type === "exchange" || type === "document" || type === "post";
}

interface ResearchTreeGroup<T> {
  tree: T;
  /** The children listed under it, in the list's order. */
  children: T[];
}

/** The parent that `id` is listed under among `ids`: its recorded parent
 * when that parent is in `ids` and is not itself a child, else null (listed
 * on its own). */
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

/** A dragged tree: its id, and the parent it is listed under, if any. */
export interface ResearchDraggedTree {
  id: string;
  parentId: string | null;
}

/** Whether a card shows its nest port while `item` is dragged: a top-level
 * card that can hold children, other than the item and the item's current
 * parent. A dragged parent's own children are child cards, which hold none.
 * A dragged parent with children may nest; the drop asks before flattening. */
export function researchNestPortShown(
  item: ResearchDraggedTree,
  card: { id: string; holdsChildren: boolean; parentId: string | null },
): boolean {
  return card.holdsChildren && card.parentId === null && card.id !== item.id && card.id !== item.parentId;
}

/** What the pointer is over during a tree drag in a place that keeps an
 * order. `after`: below the card's midpoint.
 * - `top`: a top-level card. `onPort`: on its nest port. `expanded`: its
 *   group is listed under it; `firstChildId` is its first child other than
 *   the dragged item.
 * - `child`: a child card. `nextId`: the next child other than the dragged
 *   item. `leftOfText`: left of the card's glyph.
 * - `group-exit`: the Move out strip below `parentId`'s group. */
export type ResearchCardHit =
  | {
      card: "top";
      id: string;
      holdsChildren: boolean;
      onPort: boolean;
      after: boolean;
      expanded: boolean;
      firstChildId: string | null;
    }
  | {
      card: "child";
      id: string;
      parentId: string;
      after: boolean;
      nextId: string | null;
      leftOfText: boolean;
    }
  | { card: "group-exit"; parentId: string };

/** Where a drop puts the dragged tree: nowhere, refused with a reason, under
 * a parent (before one of its children, or at the end for null), or at the
 * top level before a top-level card or after its group. */
type ResearchCardDrop =
  | { kind: "none" }
  | { kind: "refuse"; reason: string }
  | { kind: "nest"; parentId: string; beforeId: string | null }
  | { kind: "before"; id: string }
  | { kind: "after-group"; id: string };

/** The drop for a tree over a card. A top-level card's nest port nests under
 * the card. Elsewhere on a top-level card the drop goes before it in its top
 * half and after its group in its bottom half; below an expanded parent's
 * midpoint it goes before the parent's first child (a nest). A child card
 * inserts within its group; below the last child, left of its glyph, is after
 * the group at the top level. The Move out strip takes only the group's own
 * children. */
export function researchCardDrop(item: ResearchDraggedTree, hit: ResearchCardHit): ResearchCardDrop {
  if (hit.card === "group-exit") {
    return item.parentId === hit.parentId ? { kind: "after-group", id: hit.parentId } : { kind: "none" };
  }
  if (hit.card === "child") {
    if (hit.parentId === item.id) return { kind: "refuse", reason: "Can’t move a group into itself." };
    if (hit.id === item.id) return { kind: "none" };
    if (!hit.after) return { kind: "nest", parentId: hit.parentId, beforeId: hit.id };
    if (hit.nextId) return { kind: "nest", parentId: hit.parentId, beforeId: hit.nextId };
    return hit.leftOfText
      ? { kind: "after-group", id: hit.parentId }
      : { kind: "nest", parentId: hit.parentId, beforeId: null };
  }
  const portShown = researchNestPortShown(item, {
    id: hit.id,
    holdsChildren: hit.holdsChildren,
    parentId: null,
  });
  if (hit.onPort && portShown) return { kind: "nest", parentId: hit.id, beforeId: null };
  if (hit.id === item.id) return { kind: "none" };
  if (!hit.after) return { kind: "before", id: hit.id };
  if (hit.expanded) return { kind: "nest", parentId: hit.id, beforeId: hit.firstChildId };
  return { kind: "after-group", id: hit.id };
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
