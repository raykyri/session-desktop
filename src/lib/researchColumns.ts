// The column strip of an open research thread, as data. A thread shows one
// level per open conversation: level 0 is the root's inline chain, and each
// later level is a branch asked from the previous level's selected message.
// Each level renders as a messages column and an answer column, except a
// post (a note root), which is one column. An unsent branch adds a pending
// column after the level it was asked from.
//
// The strip is a pure function of the tree's nodes, the deepest selection and
// the unsent branch, so it is computed once per render and every consumer
// (rendering, keyboard, focus, scroll persistence, the feed's selection)
// reads the same columns. The DOM carries each column's identity through
// columnAttributes, and code that has to find a column element uses
// columnSelector.

import { researchLevelPath } from "./researchBranchView";
import { inlineChainFor } from "./researchThreads";
import type { ResearchHighlightAnchor, ResearchNode } from "../types";

export interface ResearchLevel {
  /** 0 is the root conversation. */
  index: number;
  /** The chain's first node: the key for the messages column's scroll
   * position, its follow-up queue and its ask box. */
  headId: string;
  /** The level's messages, oldest first. */
  chainIds: readonly string[];
  /** The message whose answer the level shows. */
  selectedId: string;
  /** The message in the previous level this branch was asked from; null for
   * the root conversation. */
  sourceId: string | null;
  /** The passage of the source answer the branch was asked about. */
  anchor: ResearchHighlightAnchor | null;
  /** A post root (a note) is one column with no answer. */
  kind: "conversation" | "branch" | "post";
}

export type ResearchColumnId = "feed" | "placeholder" | `T${number}` | `A${number}` | `P${number}`;

export type ResearchColumn =
  | { id: "feed"; role: "feed" }
  | { id: `T${number}`; role: "messages"; level: ResearchLevel }
  | { id: `T${number}`; role: "post"; level: ResearchLevel }
  | { id: `A${number}`; role: "answer"; level: ResearchLevel; nodeId: string }
  | {
      id: `P${number}`;
      role: "pending";
      levelIndex: number;
      parentNodeId: string;
      anchor: ResearchHighlightAnchor | null;
    }
  | { id: "T0"; role: "draft"; draftId: string }
  | { id: "placeholder"; role: "placeholder" };

export type ResearchPendingColumn = Extract<ResearchColumn, { role: "pending" }>;

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
 * its parent selected. */
export function researchStrip(
  nodes: readonly ResearchNode[],
  selectedNodeId: string | null,
  pending: ResearchPendingBranch | null,
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
      selectedId,
      sourceId: index === 0 ? null : (head?.parentNodeId ?? null),
      anchor: index === 0 ? null : (head?.queryAnchor ?? null),
      kind: index > 0 ? "branch" : head?.kind === "note" ? "post" : "conversation",
    };
  });
  const columns: ResearchColumn[] = [];
  for (const level of levels) {
    if (level.kind === "post") {
      columns.push({ id: `T${level.index}`, role: "post", level });
    } else {
      columns.push({ id: `T${level.index}`, role: "messages", level });
      columns.push({ id: `A${level.index}`, role: "answer", level, nodeId: level.selectedId });
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
        level.chainIds.length === other.chainIds.length &&
        level.chainIds.every((id, position) => id === other.chainIds[position])
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

/** The level a column belongs to: n for Tn, An and Pn; null otherwise. */
export function columnLevelIndex(id: string | null | undefined): number | null {
  const match = id ? /^[TAP](\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

/** The id of the column that holds `element`, or null outside the strip. */
export function columnIdOf(element: Element | null | undefined): ResearchColumnId | null {
  const id = element?.closest<HTMLElement>(columnSelector())?.dataset.researchColumn;
  return id && /^(feed|placeholder|[TAP]\d+)$/.test(id) ? (id as ResearchColumnId) : null;
}

/** Whether `id` names a messages-side column (a level's messages or post
 * column, a draft, or a pending branch). */
export function isMessagesColumnId(id: string | null | undefined): boolean {
  return Boolean(id && /^[TP]\d+$/.test(id));
}

/** The data attributes that identify a column in the DOM, written in one
 * place for every column kind. `data-research-pair` and
 * `data-research-level` are set on the columns of a level (messages, post,
 * draft and pending columns are the "turns" side). */
export function columnAttributes(column: ResearchColumn): Record<string, string> {
  switch (column.role) {
    case "feed":
    case "placeholder":
      return { "data-research-column": column.id };
    case "messages":
    case "post":
      return pairAttributes(column.id, "turns", column.level.index);
    case "answer":
      return pairAttributes(column.id, "answer", column.level.index);
    case "pending":
      return pairAttributes(column.id, "turns", column.levelIndex);
    case "draft":
      return pairAttributes(column.id, "turns", 0);
  }
}

function pairAttributes(id: ResearchColumnId, pair: "turns" | "answer", level: number) {
  return {
    "data-research-column": id,
    "data-research-pair": pair,
    "data-research-level": String(level),
  };
}

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
      return `${column.id}:${column.level.headId}`;
    case "answer":
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
export type ResearchScrollKind = "answer" | "turns";

/** The scroll persistence key of a column, or null for a column whose scroll
 * position is not kept. */
export function columnScrollKey(column: ResearchColumn): { kind: ResearchScrollKind; key: string } | null {
  switch (column.role) {
    case "answer":
      return { kind: "answer", key: column.nodeId };
    case "messages":
      return { kind: "turns", key: column.level.headId };
    default:
      return null;
  }
}
