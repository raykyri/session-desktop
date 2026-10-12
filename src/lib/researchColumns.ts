// The column strip of an open research thread, as data. A thread shows one
// level per open chain: level 0 is the root's inline chain, and each
// later level is a branch asked from the previous level's selected message.
// Each level renders as a messages column and an answer column, except a
// level whose head is a post, shown as a note (a note root, or a follow-up
// note), which renders as the note column and its follow-ups column
// (follow-ups and the follow-up composer). An unsent branch adds a pending
// column after the level it was asked from. Editing the root's document adds
// an editor column after the root level's columns; editing a note (the root
// note or a follow-up note) shows the editor column in place of its note
// column.
//
// The strip is a pure function of the tree's nodes, the deepest selection and
// the unsent branch, so it is computed once per render and every consumer
// (rendering, keyboard, focus, scroll persistence, the feed's selection)
// reads the same columns. `columnAttributes` stores each column's identity in
// the DOM, and code that has to find a column element uses
// columnSelector.

import { nodeType, passageAnchor } from "./researchNodeTypes";
import { researchLevelPath } from "./researchBranchView";
import { chainDisplayOrder, inlineChainFor } from "./researchChains";
import type { ResearchHighlightAnchor, ResearchNode } from "../types";

export interface ResearchLevel {
  /** 0 is the root level. */
  index: number;
  /** The chain's first node: the key for the messages column's scroll
   * position, its follow-up queue and its ask box. */
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

/** `Tn`: level n's messages column (a note's follow-ups column); `An`: its
 * answer column; `Nn`: a note's own column, left of its follow-ups; `Pn`: an
 * unsent branch asked from level n - 1; `En`: the editor of the document or
 * note that level n shows (a note's editor replaces `Nn`). */
export type ResearchColumnId =
  | "feed"
  | "placeholder"
  | `T${number}`
  | `A${number}`
  | `N${number}`
  | `P${number}`
  | `E${number}`;

export type ResearchColumn =
  | { id: "feed"; role: "feed" }
  | { id: `T${number}`; role: "messages"; level: ResearchLevel }
  | { id: `N${number}`; role: "post"; level: ResearchLevel }
  | { id: `T${number}`; role: "thread"; level: ResearchLevel }
  | { id: `A${number}`; role: "answer"; level: ResearchLevel; nodeId: string }
  | {
      id: `P${number}`;
      role: "pending";
      levelIndex: number;
      parentNodeId: string;
      anchor: ResearchHighlightAnchor | null;
    }
  | { id: `E${number}`; role: "editor"; levelIndex: number; nodeId: string }
  | { id: "T0"; role: "draft"; draftId: string }
  | { id: "placeholder"; role: "placeholder" };

export type ResearchPendingColumn = Extract<ResearchColumn, { role: "pending" }>;
export type ResearchEditorColumn = Extract<ResearchColumn, { role: "editor" }>;

interface ResearchStrip {
  levels: readonly ResearchLevel[];
  /** Left to right, without the feed (ResearchColumns renders it). */
  columns: readonly ResearchColumn[];
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

/** The columns for `selectedNodeId` (the deepest level's selected message)
 * and the unsent branch. A selection that is not in `nodes` yields an empty
 * strip. The pending branch opens a column only after the level that shows
 * its parent selected. `editingNodeId`, the root document or a note being
 * edited, adds the editor column: for a document, right after the root
 * level's columns, before any branch level; for a note (the root note or a
 * follow-up note), in place of that level's note column, so the level is the
 * editor and the follow-ups column. */
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
  const columns: ResearchColumn[] = [];
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
      columns.push({ id: `T${level.index}`, role: "messages", level });
      columns.push({ id: `A${level.index}`, role: "answer", level, nodeId: level.selectedId });
      if (editor) {
        columns.push(editor);
      }
    }
  }
  if (pending && path.length > 0 && path[path.length - 1] === pending.parentNodeId) {
    columns.push({
      id: `P${path.length}`,
      role: "pending",
      levelIndex: path.length,
      parentNodeId: pending.parentNodeId,
      anchor: pending.anchor,
    });
  }
  return {
    levels,
    columns,
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

/** Whether two strips show the same columns: the same levels, and the same
 * pending branch (its parent and anchor). */
export function sameResearchStrip(previous: ResearchStrip, candidate: ResearchStrip): boolean {
  if (
    previous.columns.length !== candidate.columns.length ||
    !sameResearchLevels(previous.levels, candidate.levels)
  ) {
    return false;
  }
  const editorOf = (strip: ResearchStrip) => strip.columns.find((column) => column.role === "editor");
  if (editorOf(previous)?.id !== editorOf(candidate)?.id) {
    return false;
  }
  const pendingOf = (strip: ResearchStrip) => strip.columns.find((column) => column.role === "pending");
  const before = pendingOf(previous);
  const after = pendingOf(candidate);
  return (
    before === after ||
    (before?.role === "pending" &&
      after?.role === "pending" &&
      before.parentNodeId === after.parentNodeId &&
      before.anchor === after.anchor)
  );
}

/** The level a column belongs to: n for Tn, An, Nn, Pn and En; null
 * otherwise. */
export function columnLevelIndex(id: string | null | undefined): number | null {
  const match = id ? /^[TANPE](\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

/** The id of the column that holds `element`, or null outside the strip. */
export function columnIdOf(element: Element | null | undefined): ResearchColumnId | null {
  const id = element?.closest<HTMLElement>(columnSelector())?.dataset.researchColumn;
  return id && /^(feed|placeholder|[TANPE]\d+)$/.test(id) ? (id as ResearchColumnId) : null;
}

/** Whether `id` names a messages-side column (a level's messages column or
 * a note's follow-ups column, a draft, or a pending branch). A note's own
 * column is not one. */
export function isMessagesColumnId(id: string | null | undefined): boolean {
  return Boolean(id && /^[TP]\d+$/.test(id));
}

/** A column's horizontal extent in the strip, in the strip's scroll
 * coordinates. */
interface ResearchColumnExtent {
  id: string;
  left: number;
  width: number;
}

/** The strip's scroll offset after a settle: the final column's right edge
 * at the viewport's right edge (or 0 when everything fits), then shifted the
 * least distance that shows the `focusId` column. With `skipPending`, a
 * pending branch column (Pn) is not the final column, so the strip settles as
 * it would without that column. Returns null when there are no columns to
 * align. */
export function researchStripSettleLeft(
  columns: readonly ResearchColumnExtent[],
  viewWidth: number,
  focusId: string | null,
  skipPending = false,
): number | null {
  const aligned = skipPending ? columns.filter((column) => !/^P\d+$/.test(column.id)) : columns;
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
 * draft and pending columns are the "messages" side, an answer column the
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
    case "pending":
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
 * selected message's row in a messages column, or the row in the tab order
 * in a note's follow-ups column (the open follow-up's, else the last
 * focused). */
export const COLUMN_ROW_SELECTOR =
  ".research-msg-row.is-selected .research-msg-hit, [data-research-thread-row][tabindex='0']";

/** A selector for the column `id`, or for any column. */
export function columnSelector(id?: ResearchColumnId): string {
  return id ? `[data-research-column="${id}"]` : "[data-research-column]";
}

/** The React key of a column: its id and the node it shows, so a column
 * keeps its element (and focus) while its level shows the same chain or
 * message. */
export function columnKey(column: ResearchColumn): string {
  switch (column.role) {
    case "messages":
    case "post":
    case "thread":
      return `${column.id}:${column.level.headId}`;
    case "answer":
    case "editor":
      return `${column.id}:${column.nodeId}`;
    case "pending":
      return `${column.id}:${column.parentNodeId}`;
    case "draft":
      return `${column.id}:${column.draftId}`;
    case "feed":
    case "placeholder":
      return column.id;
  }
}

/** Which saved scroll offsets a column uses: an answer column's are keyed by
 * its message, a messages column's by its chain head. */
export type ResearchScrollKind = "answer" | "messages";

/** The scroll persistence key of a column, or null for a column whose scroll
 * position is not kept. */
export function columnScrollKey(column: ResearchColumn): { kind: ResearchScrollKind; key: string } | null {
  switch (column.role) {
    case "answer":
      return { kind: "answer", key: column.nodeId };
    case "messages":
      return { kind: "messages", key: column.level.headId };
    default:
      return null;
  }
}
