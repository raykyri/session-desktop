import type { ResearchFolderState, ResearchNodeType } from "../wire/index.js";

import { researchTreeOrderAfterMove } from "./researchFolders.js";
import type { ResearchRowState } from "./researchRowGlyph.js";

// Nesting in Home: a question, a document or a post (the parent) lists other
// items (its children) under its card. One level deep: a parent is never a
// child.
// The link is `ResearchFolderState.parents` (child → parent). A child keeps
// its own membership, kept equal to its parent's, and its own position in the
// flat tree order: a group's children are listed in that order. A child whose
// parent is not a top-level item of the same list (archived, in the Trash,
// filed elsewhere) is listed on its own.

/** Questions, documents and posts (text notes, link posts and X posts) can
 * hold children; a tree whose type is unrecognized cannot. */
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
  return parent && parent !== id && ids.has(parent) && parents[parent] === undefined
    ? parent
    : null;
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
  return trees
    .filter((tree) => tree.id !== parentId && parents[tree.id] === parentId)
    .map((tree) => tree.id);
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

/** Whether the middle of a card nests `item` under it: a top-level card that
 * can hold children, other than the item and the item's current parent. A
 * dragged parent's own children are child cards, which hold none. A dragged
 * parent with children may nest; the drop asks before flattening. */
export function researchCardTakesChild(
  item: ResearchDraggedTree,
  card: { id: string; holdsChildren: boolean; parentId: string | null },
): boolean {
  return (
    card.holdsChildren && card.parentId === null && card.id !== item.id && card.id !== item.parentId
  );
}

/** The part of a card the pointer is over during a drag, `offsetY` px below
 * the card's top. A card that takes the dragged item as a child has top and
 * bottom edges a quarter of its height (at least 8px, at most 14px) that
 * insert before and after it; the band between them nests. Other cards split
 * at the midpoint. */
export function researchCardDropZone(
  height: number,
  offsetY: number,
  takesChild: boolean,
): "before" | "after" | "nest" {
  if (!takesChild) return offsetY > height / 2 ? "after" : "before";
  const edge = Math.min(14, Math.max(8, height * 0.25));
  if (offsetY < edge) return "before";
  if (offsetY > height - edge) return "after";
  return "nest";
}

/** What the pointer is over during a tree drag in a place that keeps an
 * order.
 * - `top`: a top-level card `height` px tall, with the pointer `offsetY` px
 *   below its top. `expanded`: its group is listed under it; `firstChildId`
 *   is its first child other than the dragged item.
 * - `child`: a child card. `after`: below its midpoint. `nextId`: the next
 *   child other than the dragged item. `leftOfText`: left of the card's
 *   glyph.
 * - `group-exit`: the Move out strip below `parentId`'s group. */
export type ResearchCardHit =
  | {
      card: "top";
      id: string;
      holdsChildren: boolean;
      height: number;
      offsetY: number;
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

/** Where a drop puts the dragged tree: nowhere, rejected with a reason (kind "refuse"), under
 * a parent (before one of its children, or at the end for null), or at the
 * top level before a top-level card or after its group. `onCard` marks a
 * nest from the middle band of the parent's card. */
type ResearchCardDrop =
  | { kind: "none" }
  | { kind: "refuse"; reason: string }
  | { kind: "nest"; parentId: string; beforeId: string | null; onCard?: true }
  | { kind: "before"; id: string }
  | { kind: "after-group"; id: string };

/** The drop for a tree over a card. A top-level card that takes the item as
 * a child (see `researchCardTakesChild`) nests it at the end of its group
 * from its middle band and reorders from its edges (see
 * `researchCardDropZone`); any other top-level card reorders by half. Before
 * a top-level card is at the top level; after it is after its group, or
 * before the first child of an expanded parent (a nest). A child card inserts
 * within its group; below the last child, left of its glyph, is after the
 * group at the top level. The Move out strip takes only the group's own
 * children. */
export function researchCardDrop(
  item: ResearchDraggedTree,
  hit: ResearchCardHit,
): ResearchCardDrop {
  if (hit.card === "group-exit") {
    return item.parentId === hit.parentId
      ? { kind: "after-group", id: hit.parentId }
      : { kind: "none" };
  }
  if (hit.card === "child") {
    if (hit.parentId === item.id)
      return { kind: "refuse", reason: "Can’t move a group into itself." };
    if (hit.id === item.id) return { kind: "none" };
    if (!hit.after) return { kind: "nest", parentId: hit.parentId, beforeId: hit.id };
    if (hit.nextId) return { kind: "nest", parentId: hit.parentId, beforeId: hit.nextId };
    return hit.leftOfText
      ? { kind: "after-group", id: hit.parentId }
      : { kind: "nest", parentId: hit.parentId, beforeId: null };
  }
  if (hit.id === item.id) return { kind: "none" };
  const takesChild = researchCardTakesChild(item, {
    id: hit.id,
    holdsChildren: hit.holdsChildren,
    parentId: null,
  });
  const zone = researchCardDropZone(hit.height, hit.offsetY, takesChild);
  if (zone === "nest") return { kind: "nest", parentId: hit.id, beforeId: null, onCard: true };
  if (zone === "before") return { kind: "before", id: hit.id };
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

/** How long a collapsing click waits, so the second press of a double-click
 * can cancel it before the group closes. */
export const RESEARCH_GROUP_COLLAPSE_DELAY_MS = 250;

/** What a click on a card does to its group.
 *
 * A collapsed group expands, and the card still opens. A later single click
 * on the already selected, expanded group collapses it. The second click of
 * a double-click does neither: a note edits on double-click, and that press
 * is not the collapse. A key (`detail` 0) expands a collapsed group and
 * otherwise opens; it does not collapse.
 *
 * `detail` is the click's `event.detail`. */
export type ResearchGroupCardClick = "expand" | "collapse" | "open" | "ignore";

export function researchGroupCardClick(input: {
  /** The card lists children. */
  group: boolean;
  collapsed: boolean;
  /** The card is the open selection. */
  selected: boolean;
  detail: number;
}): ResearchGroupCardClick {
  if (input.detail > 1) return "ignore";
  if (input.group && input.collapsed) return "expand";
  if (input.group && !input.collapsed && input.selected && input.detail === 1) return "collapse";
  return "open";
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
