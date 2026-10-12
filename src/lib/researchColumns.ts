// The column strip of an open research thread, as data. A thread shows one
// level per column that has a selection: level 0 is the root's inline
// chain, and level n + 1 is the branch selected in the branches column after
// level n. Each level renders as a messages column and an answer column,
// except a level whose head is a post, shown as a note (a note root, or a
// follow-up note), which renders as the note column and its follow-ups
// column (follow-ups and the follow-up composer).
//
// The branches column after a level lists every branch whose parent message
// is listed in the level's messages column (for a branch level, that is
// every group of its branches column): one group per branch, in the order
// the parent messages are listed, and each message's branches in reading
// order (passages from the top, then whole-answer branches). Each group has
// its source, its messages and its queue; the group that holds the column's
// selection also has the ask box. Which messages a column lists does not
// depend on what any column selects, so each column keeps its own selection:
// selecting a message in one column leaves the columns after it as they
// are. Clearing a column's selection removes the columns after it. An unsent
// branch is a group in the branches column after the deepest level, when
// that level's selected message is its parent. A note's follow-ups are
// listed in its follow-ups column instead, so a note level's branches
// column holds only an unsent branch. Editing the root's document adds an
// editor column after the root level's answer column; editing a note (the
// root note or a follow-up note) shows the editor column in place of its
// note column.
//
// The strip is a pure function of the tree's nodes, the selection of each
// column and the unsent branch, so it is computed once per render and every
// consumer (rendering, keyboard, focus, scroll persistence, the feed's
// selection) reads the same columns. `columnAttributes` stores each column's
// identity in the DOM, and code that has to find a column element uses
// columnSelector.

import { nodeType, passageAnchor } from "./researchNodeTypes";
import { researchBranchesByParent, researchBranchesInPassageOrder, researchLevelPath } from "./researchBranchView";
import { chainDisplayOrder, inlineChainFor, inlineChainsFromHeads } from "./researchChains";
import type { ResearchHighlightAnchor, ResearchNode } from "../types";

export interface ResearchLevel {
  /** 0 is the root level. */
  index: number;
  /** The chain's first node: the key for its follow-up queue and its ask
   * box, and for a messages column's scroll position. */
  headId: string;
  /** The level's messages, oldest first: the order the inline links give
   * (a follow-up continues the last). */
  chainIds: readonly string[];
  /** The same messages in the order the messages column lists them (see
   * `chainDisplayOrder`), which the keys and ⌃Tab follow. */
  displayIds: readonly string[];
  /** The message whose answer the level shows. */
  selectedId: string;
  /** The message in the previous level this branch was asked from; null for
   * the root level. */
  sourceId: string | null;
  /** The passage of the source answer the branch was asked about. */
  anchor: ResearchHighlightAnchor | null;
  /** A level whose head is a post (the root note, or a follow-up note) is a
   * note column and a follow-ups column, with no answer. */
  kind: "root" | "branch" | "post";
}

/** One branch in a branches column: its chain, what it was asked about, and
 * its selected message when it is the open level. */
interface ResearchBranchGroup {
  kind: "branch";
  headId: string;
  chainIds: readonly string[];
  /** The order the group lists its messages in (see `chainDisplayOrder`). */
  displayIds: readonly string[];
  /** The message of the previous level it was asked from. */
  sourceId: string;
  anchor: ResearchHighlightAnchor | null;
  /** The selected message when this branch is the open level, else null. */
  selectedId: string | null;
}

/** The unsent branch: a group in the branches column after the level that
 * shows its parent selected. */
export interface ResearchPendingGroup {
  kind: "pending";
  /** The level the branch opens as once it is sent. */
  levelIndex: number;
  parentNodeId: string;
  anchor: ResearchHighlightAnchor | null;
}

export type ResearchStackGroup = ResearchBranchGroup | ResearchPendingGroup;

/** `Tn`: level n's messages column, a note's follow-ups column, or the
 * branches column after level n - 1 (level n's messages column when one of
 * its branches is open); `An`: level n's answer column; `Nn`: a note's own
 * column, left of its follow-ups; `En`: the editor of the document or note
 * that level n shows (a note's editor replaces `Nn`). */
export type ResearchColumnId =
  | "feed"
  | "placeholder"
  | `T${number}`
  | `A${number}`
  | `N${number}`
  | `E${number}`;

export type ResearchColumn =
  | { id: "feed"; role: "feed" }
  | { id: `T${number}`; role: "messages"; level: ResearchLevel }
  | { id: `N${number}`; role: "post"; level: ResearchLevel }
  | { id: `T${number}`; role: "thread"; level: ResearchLevel }
  | { id: `A${number}`; role: "answer"; level: ResearchLevel; nodeId: string }
  | {
      id: `T${number}`;
      role: "branches";
      /** The level a branch opens as: `source.index + 1`. */
      levelIndex: number;
      /** The level whose messages the branches were asked from. */
      source: ResearchLevel;
      /** The open branch's level, or null when none of them is open. */
      level: ResearchLevel | null;
      /** In reading order; never empty. */
      groups: readonly ResearchStackGroup[];
    }
  | { id: `E${number}`; role: "editor"; levelIndex: number; nodeId: string }
  | { id: "T0"; role: "draft"; draftId: string }
  | { id: "placeholder"; role: "placeholder" };

export type ResearchBranchesColumn = Extract<ResearchColumn, { role: "branches" }>;
export type ResearchEditorColumn = Extract<ResearchColumn, { role: "editor" }>;

interface ResearchStrip {
  levels: readonly ResearchLevel[];
  /** Left to right, without the feed (ResearchColumns renders it). */
  columns: readonly ResearchColumn[];
  /** The unsent branch's group, when the strip shows it. */
  pending: ResearchPendingGroup | null;
  /** The last column is an answer, so the filler after it shows its hint. */
  endsWithAnswer: boolean;
  /** The feed's selection: the root level's selected message, then each
   * open branch's head. */
  openNodeIds: readonly string[];
}

/** An unsent branch: the message it is asked from, and the passage. */
interface ResearchPendingBranch {
  parentNodeId: string;
  anchor: ResearchHighlightAnchor | null;
}

const pendingGroup = (level: ResearchLevel, pending: ResearchPendingBranch): ResearchPendingGroup => ({
  kind: "pending",
  levelIndex: level.index + 1,
  parentNodeId: pending.parentNodeId,
  anchor: pending.anchor,
});

/** The groups of a branches column: the branches of each message `listed`
 * in the column before it, in that order, and each message's branches in
 * reading order (by where their passage starts, then the whole-answer ones,
 * each oldest first). The unsent branch `pending` goes before its parent's
 * first branch whose passage starts after its own; an unsent whole-answer
 * branch goes after its parent's branches. A note level lists no branches:
 * its follow-ups column does. */
function branchGroups(
  level: ResearchLevel,
  listed: readonly string[],
  next: ResearchLevel | null,
  branchesByParent: ReadonlyMap<string, ResearchNode[]>,
  chainOf: (headId: string) => string[],
  pending: ResearchPendingBranch | null,
): ResearchStackGroup[] {
  const groups: ResearchStackGroup[] = [];
  for (const messageId of listed) {
    const children = level.kind === "post" ? [] : (branchesByParent.get(messageId) ?? []);
    const startOf = new Map(children.map((branch) => [branch.id, passageAnchor(branch)?.start ?? null]));
    const branches = researchBranchesInPassageOrder(children);
    const unsent = pending?.parentNodeId === messageId ? pending : null;
    let unsentAt = -1;
    if (unsent) {
      const passageStart = unsent.anchor?.start ?? null;
      const after =
        passageStart === null
          ? -1
          : branches.findIndex((branch) => {
              const start = startOf.get(branch.id) ?? null;
              return start === null || start > passageStart;
            });
      unsentAt = after < 0 ? branches.length : after;
    }
    branches.forEach((branch, index) => {
      if (unsent && index === unsentAt) {
        groups.push(pendingGroup(level, unsent));
      }
      const chainIds = chainOf(branch.id);
      groups.push({
        kind: "branch",
        headId: branch.id,
        chainIds,
        displayIds: chainDisplayOrder(chainIds, branch.chainOrder),
        sourceId: messageId,
        anchor: passageAnchor(branch),
        selectedId: next && next.headId === branch.id ? next.selectedId : null,
      });
    });
    if (unsent && unsentAt === branches.length) {
      groups.push(pendingGroup(level, unsent));
    }
  }
  return groups;
}

/** The messages of every branch group, top to bottom. */
const groupMessageIds = (groups: readonly ResearchStackGroup[]) =>
  groups.flatMap((group) => (group.kind === "branch" ? group.displayIds : []));

/** A level, and the messages its messages-side column lists. */
interface OpenedLevel {
  level: ResearchLevel;
  listed: readonly string[];
}

/** The levels a selection opens, one per column with a selection, before
 * the strip lays out their columns. `selection` holds each column's
 * selected message, root column first; it is cut at the first entry that
 * its column does not list. Column 0 lists the root's chain. After a level
 * whose head is a post, the next column lists the chain of the post's
 * follow-up selected in it; after any other level, the branches column
 * lists every branch of every message the level's column lists. */
function researchSelectionLevels(
  nodes: readonly ResearchNode[],
  selection: readonly string[],
  branchesByParent: ReadonlyMap<string, ResearchNode[]>,
  chainOf: (headId: string) => string[],
): OpenedLevel[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const opened: OpenedLevel[] = [];
  for (const selectedId of selection) {
    if (!byId.has(selectedId)) {
      break;
    }
    const index = opened.length;
    const chainIds = inlineChainFor(nodes, selectedId);
    const headId = chainIds[0] ?? selectedId;
    const head = byId.get(headId);
    const parentId = head?.parentNodeId ?? null;
    const previous = index > 0 ? opened[index - 1] : null;
    if (previous === null ? parentId !== null : parentId === null) {
      break;
    }
    if (
      previous &&
      parentId !== null &&
      !(previous.level.kind === "post" ? parentId === previous.level.selectedId : previous.listed.includes(parentId))
    ) {
      break;
    }
    const displayIds = chainDisplayOrder(chainIds, head?.chainOrder);
    const level: ResearchLevel = {
      index,
      headId,
      chainIds,
      displayIds,
      selectedId,
      sourceId: index === 0 ? null : parentId,
      anchor: index === 0 || !head ? null : passageAnchor(head),
      kind: head && nodeType(head) === "post" ? "post" : index > 0 ? "branch" : "root",
    };
    // A branch level's column is the branches column after the level
    // before it, which lists every group; a level opened from a note lists
    // only its own chain.
    const listed =
      previous === null || previous.level.kind === "post"
        ? displayIds
        : groupMessageIds(branchGroups(previous.level, previous.listed, null, branchesByParent, chainOf, null));
    opened.push({ level, listed });
  }
  return opened;
}

/** `selection` cut to the part the tree shows: each column's selected
 * message, root column first, up to the first one its column does not
 * list (see researchStrip). */
export function researchSelectionPath(nodes: readonly ResearchNode[], selection: readonly string[]): string[] {
  return researchSelectionLevels(nodes, selection, researchBranchesByParent(nodes), inlineChainsFromHeads(nodes)).map(
    ({ level }) => level.selectedId,
  );
}

/** The selection a thread opens with, from its saved selection (see
 * savedResearchSelection). A saved message alone, the format stored before
 * each column kept its own selection, opens the levels it was asked from; a
 * saved path opens cut to the part the tree lists. A saved selection the
 * tree does not show opens the last message of the root's chain. */
export function researchRestoredSelection(
  nodes: readonly ResearchNode[],
  rootNodeId: string,
  saved: string | readonly string[] | null,
): string | string[] {
  if (typeof saved === "string" && nodes.some((node) => node.id === saved)) {
    return saved;
  }
  const path = saved !== null && typeof saved !== "string" ? researchSelectionPath(nodes, saved) : [];
  if (path.length > 0) {
    return path;
  }
  const main = inlineChainFor(nodes, rootNodeId);
  return main[main.length - 1] ?? rootNodeId;
}

/** `selection` with `nodeId` selected in the column that lists it. The
 * columns before that one keep their selection, and so do the columns after
 * it, which list the same messages whatever it selects. A node that no
 * open column lists opens the levels it was asked from instead (see
 * researchLevelPath). */
export function researchSelectionWith(
  nodes: readonly ResearchNode[],
  selection: readonly string[],
  nodeId: string,
): string[] {
  const path = researchSelectionPath(nodes, selection);
  for (let index = 0; index <= path.length; index += 1) {
    const candidate = [...path.slice(0, index), nodeId, ...path.slice(index + 1)];
    const valid = researchSelectionPath(nodes, candidate);
    if (valid[index] === nodeId) {
      return valid;
    }
  }
  return researchLevelPath(nodes, nodeId);
}

/** `selection` after messages were removed from the tree (`nodes` is what
 * remains): a removed selection becomes `survivor` of it (the nearest
 * remaining message it was asked from or followed), and the selection is
 * then cut where a column does not list its entry. A column whose selected
 * branch was removed, with the message it was asked from, closes with the
 * columns after it. */
export function researchSelectionAfterRemoval(
  nodes: readonly ResearchNode[],
  selection: readonly string[],
  survivor: (nodeId: string) => string | null,
): string[] {
  const present = new Set(nodes.map((node) => node.id));
  const replaced: string[] = [];
  for (const nodeId of selection) {
    const kept = present.has(nodeId) ? nodeId : survivor(nodeId);
    if (!kept) {
      break;
    }
    replaced.push(kept);
  }
  return researchSelectionPath(nodes, replaced);
}

/** The columns for `selection` (each column's selected message, root
 * column first; a single id opens the levels it was asked from, see
 * researchLevelPath) and the unsent branch. A selection whose first message
 * is not in `nodes` yields an empty strip. A level whose column lists
 * messages with branches is followed by its branches column, and the
 * level selected there by its answer column. The unsent branch is shown
 * only when its parent is the deepest selection, in the branches column
 * after that level. `editingNodeId`, the root document or a note being
 * edited, adds the editor column: for a document, right after the root
 * level's answer column, before its branches column; for a note (the root
 * note or a follow-up note), in place of that level's note column, so the
 * level is the editor and the follow-ups column. */
export function researchStrip(
  nodes: readonly ResearchNode[],
  selection: string | readonly string[] | null,
  pending: ResearchPendingBranch | null,
  editingNodeId: string | null = null,
): ResearchStrip {
  const requested =
    selection === null
      ? []
      : typeof selection === "string"
        ? nodes.some((node) => node.id === selection)
          ? researchLevelPath(nodes, selection)
          : []
        : selection;
  const branchesByParent =
    requested.length > 0 ? researchBranchesByParent(nodes) : new Map<string, ResearchNode[]>();
  const chainOf = inlineChainsFromHeads(nodes);
  const opened = researchSelectionLevels(nodes, requested, branchesByParent, chainOf);
  const levels = opened.map(({ level }) => level);
  const deepest = levels[levels.length - 1]?.selectedId ?? null;
  const shownPending = pending && deepest !== null && deepest === pending.parentNodeId ? pending : null;
  const columns: ResearchColumn[] = [];
  let pendingShown: ResearchPendingGroup | null = null;
  // The level's messages column is the previous level's branches column.
  let inBranches = false;
  for (const { level, listed } of opened) {
    // A document is edited only as the root; a note (the root note or a
    // follow-up note) at the level that shows it.
    const editor: ResearchColumn | null =
      editingNodeId !== null && level.headId === editingNodeId && (level.index === 0 || level.kind === "post")
        ? { id: `E${level.index}`, role: "editor", levelIndex: level.index, nodeId: editingNodeId }
        : null;
    if (level.kind === "post") {
      columns.push(editor ?? { id: `N${level.index}`, role: "post", level });
      columns.push({ id: `T${level.index}`, role: "thread", level });
    } else {
      if (!inBranches) {
        columns.push({ id: `T${level.index}`, role: "messages", level });
      }
      columns.push({ id: `A${level.index}`, role: "answer", level, nodeId: level.selectedId });
      if (editor) {
        columns.push(editor);
      }
    }
    inBranches = false;
    const next = levels[level.index + 1] ?? null;
    const groups = branchGroups(level, listed, next, branchesByParent, chainOf, next ? null : shownPending);
    // The next level is one of the groups, unless it opens from a note's
    // follow-ups column (or is a follow-up note): then it shows its own
    // columns, and the branches column is left out.
    const open = next && groups.some((group) => group.kind === "branch" && group.headId === next.headId) ? next : null;
    if (groups.length === 0 || (next && (!open || next.kind === "post"))) {
      continue;
    }
    pendingShown = groups.find((group): group is ResearchPendingGroup => group.kind === "pending") ?? pendingShown;
    columns.push({ id: `T${level.index + 1}`, role: "branches", levelIndex: level.index + 1, source: level, level: open, groups });
    inBranches = open !== null;
  }
  return {
    levels,
    columns,
    pending: pendingShown,
    endsWithAnswer: columns[columns.length - 1]?.role === "answer",
    openNodeIds: levels.map((level, index) => (index === 0 ? level.selectedId : level.headId)),
  };
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, position) => id === right[position]);

/** Whether two level lists show the same chains and selections. A branch's
 * anchor is fixed when the branch is created, so levels compare by their
 * node ids. */
export function sameResearchLevels(
  previous: readonly ResearchLevel[],
  candidate: readonly ResearchLevel[],
): boolean {
  return (
    previous.length === candidate.length &&
    previous.every((level, index) => {
      const other = candidate[index];
      return (
        level.headId === other.headId &&
        level.selectedId === other.selectedId &&
        level.sourceId === other.sourceId &&
        level.kind === other.kind &&
        sameIds(level.chainIds, other.chainIds) &&
        sameIds(level.displayIds, other.displayIds)
      );
    })
  );
}

/** Whether two branches-column groups show the same branch (or the same
 * unsent branch: its parent and passage) and selection. */
function sameGroup(left: ResearchStackGroup, right: ResearchStackGroup): boolean {
  if (left.kind === "pending" || right.kind === "pending") {
    return (
      left.kind === "pending" &&
      right.kind === "pending" &&
      left.levelIndex === right.levelIndex &&
      left.parentNodeId === right.parentNodeId &&
      left.anchor === right.anchor
    );
  }
  return (
    left.headId === right.headId &&
    left.sourceId === right.sourceId &&
    left.selectedId === right.selectedId &&
    sameIds(left.chainIds, right.chainIds) &&
    sameIds(left.displayIds, right.displayIds)
  );
}

/** Whether two strips show the same columns: the same levels, branches
 * columns with the same groups, the same editor and the same unsent
 * branch. */
export function sameResearchStrip(previous: ResearchStrip, candidate: ResearchStrip): boolean {
  if (
    previous.columns.length !== candidate.columns.length ||
    !sameResearchLevels(previous.levels, candidate.levels)
  ) {
    return false;
  }
  return previous.columns.every((column, index) => {
    const other = candidate.columns[index];
    if (column.id !== other.id || column.role !== other.role) {
      return false;
    }
    if (column.role === "editor" && other.role === "editor") {
      return column.nodeId === other.nodeId;
    }
    if (column.role === "branches" && other.role === "branches") {
      return (
        (column.level === null) === (other.level === null) &&
        column.groups.length === other.groups.length &&
        column.groups.every((group, position) => sameGroup(group, other.groups[position]))
      );
    }
    return true;
  });
}

/** The level a column belongs to: n for Tn, An, Nn and En; null
 * otherwise. */
export function columnLevelIndex(id: string | null | undefined): number | null {
  const match = id ? /^[TANE](\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

/** The id of the column that holds `element`, or null outside the strip. */
export function columnIdOf(element: Element | null | undefined): ResearchColumnId | null {
  const id = element?.closest<HTMLElement>(columnSelector())?.dataset.researchColumn;
  return id && /^(feed|placeholder|[TANE]\d+)$/.test(id) ? (id as ResearchColumnId) : null;
}

/** Whether `id` names a messages-side column (a level's messages column, a
 * note's follow-ups column, a branches column, or a draft). A note's own
 * column is not one. */
export function isMessagesColumnId(id: string | null | undefined): boolean {
  return Boolean(id && /^T\d+$/.test(id));
}

/** A column's horizontal extent in the strip, in the strip's scroll
 * coordinates. `pendingOnly`: a branches column that holds only an unsent
 * branch. */
interface ResearchColumnExtent {
  id: string;
  left: number;
  width: number;
  pendingOnly?: boolean;
}

/** The strip's scroll offset after a settle: the final column's right edge
 * at the viewport's right edge (or 0 when everything fits), then shifted the
 * least distance that shows the `focusId` column. With `skipPending`, a
 * branches column that holds only an unsent branch is not the final column,
 * so the strip settles as it would without that column. Returns null when
 * there are no columns to align. */
export function researchStripSettleLeft(
  columns: readonly ResearchColumnExtent[],
  viewWidth: number,
  focusId: string | null,
  skipPending = false,
): number | null {
  const aligned = skipPending ? columns.filter((column) => !column.pendingOnly) : columns;
  const last = aligned[aligned.length - 1];
  if (!last) return null;
  let left = Math.max(0, last.left + last.width - viewWidth);
  const focus = focusId ? columns.find((column) => column.id === focusId) : undefined;
  if (focus) {
    if (focus.left < left) left = focus.left;
    if (focus.left + focus.width > left + viewWidth) {
      left = focus.left + focus.width - viewWidth;
    }
  }
  return left;
}

/** The data attributes that identify a column in the DOM, written in one
 * place for every column kind. `data-research-pair` and
 * `data-research-level` are set on the columns of a level: messages, thread,
 * branches and draft columns are the "messages" side, an answer column the
 * "answer" side, a post's own column is "post", and the editor "editor". */
export function columnAttributes(column: ResearchColumn): Record<string, string> {
  switch (column.role) {
    case "feed":
    case "placeholder":
      return { "data-research-column": column.id };
    case "messages":
    case "thread":
      return pairAttributes(column.id, "messages", column.level.index);
    case "post":
      return pairAttributes(column.id, "post", column.level.index);
    case "answer":
      return pairAttributes(column.id, "answer", column.level.index);
    case "branches":
      return pairAttributes(column.id, "messages", column.levelIndex);
    case "draft":
      return pairAttributes(column.id, "messages", 0);
    case "editor":
      return pairAttributes(column.id, "editor", column.levelIndex);
  }
}

function pairAttributes(id: ResearchColumnId, pair: "messages" | "answer" | "post" | "editor", level: number) {
  return {
    "data-research-column": id,
    "data-research-pair": pair,
    "data-research-level": String(level),
  };
}

/** The row that keyboard focus returns to in a messages-side column: the
 * selected message's row in a messages or branches column, or the row in
 * the tab order in a note's follow-ups column (the open follow-up's, else
 * the last focused). */
export const COLUMN_ROW_SELECTOR =
  ".research-msg-row.is-selected .research-msg-hit, [data-research-thread-row][tabindex='0']";

/** A selector for the column `id`, or for any column. */
export function columnSelector(id?: ResearchColumnId): string {
  return id ? `[data-research-column="${id}"]` : "[data-research-column]";
}

/** The React key of a column: its id and the node it shows, so a column
 * keeps its element (and focus) while its level shows the same chain or
 * message. A branches column keeps its element while it is shown: the
 * messages it lists do not depend on any column's selection. */
export function columnKey(column: ResearchColumn): string {
  switch (column.role) {
    case "messages":
    case "post":
    case "thread":
      return `${column.id}:${column.level.headId}`;
    case "branches":
      return `${column.id}:branches`;
    case "answer":
    case "editor":
      return `${column.id}:${column.nodeId}`;
    case "draft":
      return `${column.id}:${column.draftId}`;
    case "feed":
    case "placeholder":
      return column.id;
  }
}

/** Which saved scroll offsets a column uses: an answer column's are keyed by
 * its message, a messages column's by its chain head, and a branches
 * column's by the head of its first branch (the unsent branch's parent when
 * it lists only that). */
export type ResearchScrollKind = "answer" | "messages" | "branches";

/** The scroll persistence key of a column, or null for a column whose scroll
 * position is not kept. */
export function columnScrollKey(column: ResearchColumn): { kind: ResearchScrollKind; key: string } | null {
  switch (column.role) {
    case "answer":
      return { kind: "answer", key: column.nodeId };
    case "messages":
      return { kind: "messages", key: column.level.headId };
    case "branches": {
      // An unsent branch listed first does not change the key, so its
      // column keeps its offset while the branch is written.
      const first = column.groups.find((group) => group.kind === "branch") ?? column.groups[0];
      return {
        kind: "branches",
        key: first ? (first.kind === "branch" ? first.headId : first.parentNodeId) : "",
      };
    }
    default:
      return null;
  }
}

/** The messages a messages-side column lists, top to bottom: a messages
 * column's, or every group's in a branches column (an unsent branch has
 * none). ↑/↓ and ⌃Tab move along this list. */
export function columnMessageIds(column: ResearchColumn): string[] {
  switch (column.role) {
    case "messages":
      return [...column.level.displayIds];
    case "branches":
      return column.groups.flatMap((group) => (group.kind === "branch" ? group.displayIds : []));
    default:
      return [];
  }
}

/** The branch group that lists `nodeId` in a branches column. */
export function branchGroupOf(column: ResearchBranchesColumn, nodeId: string): ResearchBranchGroup | null {
  return (
    column.groups.find(
      (group): group is ResearchBranchGroup => group.kind === "branch" && group.chainIds.includes(nodeId),
    ) ?? null
  );
}
