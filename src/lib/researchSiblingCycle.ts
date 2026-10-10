// ⌃Tab / ⌃⇧Tab in the research columns: select the next or previous row of
// the column the person last interacted with, wrapping at both ends. The
// feed cycles its cards (or a card's child rows), a messages column its
// chain, and a post's thread column its rows. ResearchColumns tracks the
// column and dispatches the key; the feed and the document do the moves.
// This module holds the parts that need no DOM.

import type { ResearchColumnId } from "./researchColumns";

/** 1 for the next row, -1 for the previous one. */
type ResearchCycleDirection = 1 | -1;

/** What ResearchColumns passes to the feed's and the document's handlers. */
export interface ResearchCycleRequest {
  /** The column last focused, clicked or typed in; null before any. */
  column: ResearchColumnId | null;
  direction: ResearchCycleDirection;
  /** Focus is in a text field, which keeps it; otherwise focus moves to the
   * newly selected row. */
  keepFocus: boolean;
}

interface CycleKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌃Tab steps forward and ⌃⇧Tab backward. Combinations with ⌥ or ⌘ are not
 * cycle keys. */
export function researchCycleDirection(event: CycleKeyInput): ResearchCycleDirection | null {
  if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  return event.shiftKey ? -1 : 1;
}

/** The index one step in `direction` from `index` in a list of `count`
 * items, wrapping at both ends. With no current item (`index` outside the
 * list), forward starts at the first item and backward at the last. -1 for an
 * empty list. */
export function cycleIndex(count: number, index: number, direction: ResearchCycleDirection): number {
  if (count <= 0) {
    return -1;
  }
  if (index < 0 || index >= count) {
    return direction === 1 ? 0 : count - 1;
  }
  return (index + direction + count) % count;
}

/** A column's position in the strip, left to right: Nn, Tn, An, En for level
 * n. An unsent branch's Pn takes the slot level n's post column would have,
 * after level n - 1's columns. Null for the feed, the placeholder and
 * unknown ids. */
function stripRank(id: string): number | null {
  const match = /^([NPTAE])(\d+)$/.exec(id);
  if (!match) {
    return null;
  }
  const slot = { N: 0, P: 0, T: 1, A: 2, E: 3 }[match[1] as "N" | "P" | "T" | "A" | "E"];
  return Number(match[2]) * 4 + slot;
}

/** The column whose rows ⌃Tab cycles. `candidates` are the strip's columns
 * that have rows (messages columns, and thread columns with at least one
 * row). The column last interacted with is used when it is one; an answer
 * column cycles its level's messages column, and any other column without
 * rows (a post, an editor, a pending branch, a draft) falls back to the
 * nearest candidate to its left. A column with no candidate to its left, the
 * feed, the placeholder, or no column at all, cycles the feed. */
export function researchCycleColumn(
  candidates: readonly ResearchColumnId[],
  last: ResearchColumnId | null,
): ResearchColumnId | "feed" {
  const lastRank = last ? stripRank(last) : null;
  if (lastRank === null) {
    return "feed";
  }
  let best: { id: ResearchColumnId; rank: number } | null = null;
  for (const id of candidates) {
    const rank = stripRank(id);
    if (rank !== null && rank <= lastRank && (!best || rank > best.rank)) {
      best = { id, rank };
    }
  }
  return best?.id ?? "feed";
}

/** A feed card as the cycle sees it: its key and its child rows' node ids. */
export interface FeedCycleEntry {
  key: string;
  children: readonly string[];
}

/** A feed row: a card, or one of its child rows. */
export interface FeedCyclePosition {
  key: string;
  child: string | null;
}

/** The feed row one step from `current`. A child row steps among its card's
 * child rows; a card steps among the cards of the list that holds it (the
 * feed's lists are separate: Home's recent activity and each open tray, or a
 * folder's cards). With no current row, or one no list holds, the step
 * starts in the first non-empty list. Null when every list is empty. */
export function feedCycleStep(
  lists: readonly (readonly FeedCycleEntry[])[],
  current: FeedCyclePosition | null,
  direction: ResearchCycleDirection,
): FeedCyclePosition | null {
  const list = (current && lists.find((entries) => entries.some((entry) => entry.key === current.key))) ?? null;
  if (current && list) {
    const index = list.findIndex((entry) => entry.key === current.key);
    const children = list[index].children;
    const childIndex = current.child === null ? -1 : children.indexOf(current.child);
    if (childIndex >= 0) {
      return { key: current.key, child: children[cycleIndex(children.length, childIndex, direction)] };
    }
    return { key: list[cycleIndex(list.length, index, direction)].key, child: null };
  }
  const first = lists.find((entries) => entries.length > 0);
  if (!first) {
    return null;
  }
  return { key: first[cycleIndex(first.length, -1, direction)].key, child: null };
}
