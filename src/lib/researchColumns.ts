// The column strip of an open research thread, as data. A thread shows one
// level per open chain: level 0 is the root's inline chain, and each
// later level is a branch asked from a message of the previous level.
// Each level renders as a messages column and an answer column, except a
// level whose head is a post, shown as a note (a note root, or a follow-up
// note), which renders as the note column and its follow-ups column
// (follow-ups and the follow-up composer).
//
// The branches of a level's messages (passages of a document and of each AI
// answer, or whole answers) are listed together in one branches column after
// the level's answer column: one group per branch, in the reading order of
// their sources (the level's messages as listed, and each message's
// passages from the top), each with its source, its messages and its ask
// box. The branch whose message is selected is the next level: the branches
// column is that level's messages column, and the level's answer column
// follows it. An unsent branch is a group in the branches column of the
// level that shows its parent selected, at its source's position. A note's
// follow-ups are listed in its follow-ups column instead, so a note level's
// branches column holds only an unsent branch. Editing the root's document
// adds an editor column after the root level's answer column; editing a
// note (the root note or a follow-up note) shows the editor column in place
// of its note column.
//
// The strip is a pure function of the tree's nodes, the deepest selection and
// the unsent branch, so it is computed once per render and every consumer
// (rendering, keyboard, focus, scroll persistence, the feed's selection)
// reads the same columns. `columnAttributes` stores each column's identity in
// the DOM, and code that has to find a column element uses
// columnSelector.

import { nodeType, passageAnchor } from "./researchNodeTypes";
import { researchBranchesByParent, researchBranchesInReadingOrder, researchLevelPath } from "./researchBranchView";
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

/** The groups of a level's branches column: the branches of each of the
 * level's messages, in the order the messages are listed, and each
 * message's branches in reading order (by where their passage starts, then
 * the whole-answer ones, each oldest first). The unsent branch `pending`
 * goes before its parent's first branch whose passage starts after its
 * own; an unsent whole-answer branch goes after its parent's branches. A
 * note level lists no branches: its follow-ups column does. */
function branchGroups(
  level: ResearchLevel,
  next: ResearchLevel | null,
  branchesByParent: ReadonlyMap<string, ResearchNode[]>,
  chainOf: (headId: string) => string[],
  pending: ResearchPendingBranch | null,
): ResearchStackGroup[] {
  const groups: ResearchStackGroup[] = [];
  for (const messageId of level.displayIds) {
    const children = level.kind === "post" ? [] : (branchesByParent.get(messageId) ?? []);
    const startOf = new Map(children.map((branch) => [branch.id, passageAnchor(branch)?.start ?? null]));
    const branches = researchBranchesInReadingOrder(children, (branchId) => startOf.get(branchId) ?? null);
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

/** The columns for `selectedNodeId` (the deepest level's selected message)
 * and the unsent branch. A selection that is not in `nodes` yields an empty
 * strip. A level whose messages have branches is followed by its branches
 * column, and the open branch's level by its answer column. The unsent
 * branch is shown only when its parent is the deepest selection, in that
 * level's branches column. `editingNodeId`, the root document or a note
 * being edited, adds the editor column: for a document, right after the
 * root level's answer column, before its branches column; for a note (the
 * root note or a follow-up note), in place of that level's note column, so
 * the level is the editor and the follow-ups column. */
export function researchStrip(
  nodes: readonly ResearchNode[],
  selectedNodeId: string | null,
  pending: ResearchPendingBranch | null,
  editingNodeId: string | null = null,
): ResearchStrip {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = selectedNodeId && byId.has(selectedNodeId) ? researchLevelPath(nodes, selectedNodeId) : [];
  const levels = path.map((selectedId, index): ResearchLevel => {
    const chainIds = inlineChainFor(nodes, selectedId);
    const headId = chainIds[0] ?? selectedId;
    const head = byId.get(headId);
    return {
      index,
      headId,
      chainIds,
      displayIds: chainDisplayOrder(chainIds, head?.chainOrder),
      selectedId,
      sourceId: index === 0 ? null : (head?.parentNodeId ?? null),
      anchor: index === 0 || !head ? null : passageAnchor(head),
      kind: head && nodeType(head) === "post" ? "post" : index > 0 ? "branch" : "root",
    };
  });
  const branchesByParent = levels.length > 0 ? researchBranchesByParent(nodes) : new Map<string, ResearchNode[]>();
  const chainOf = inlineChainsFromHeads(nodes);
  const shownPending = pending && path.length > 0 && path[path.length - 1] === pending.parentNodeId ? pending : null;
  const columns: ResearchColumn[] = [];
  let pendingShown: ResearchPendingGroup | null = null;
  // The level's messages column is the previous level's branches column.
  let inBranches = false;
  for (const level of levels) {
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
    const groups = branchGroups(level, next, branchesByParent, chainOf, next ? null : shownPending);
    // The open level is one of the groups, unless it opens from a note's
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
 * message. A branches column keeps its element while it lists the branches
 * of the same level, whichever of them is open. */
export function columnKey(column: ResearchColumn): string {
  switch (column.role) {
    case "messages":
    case "post":
    case "thread":
      return `${column.id}:${column.level.headId}`;
    case "branches":
      return `${column.id}:branches:${column.source.headId}`;
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
 * column's by the head of the level the branches were asked from. */
export type ResearchScrollKind = "answer" | "messages" | "branches";

/** The scroll persistence key of a column, or null for a column whose scroll
 * position is not kept. */
export function columnScrollKey(column: ResearchColumn): { kind: ResearchScrollKind; key: string } | null {
  switch (column.role) {
    case "answer":
      return { kind: "answer", key: column.nodeId };
    case "messages":
      return { kind: "messages", key: column.level.headId };
    case "branches":
      return { kind: "branches", key: column.source.headId };
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
