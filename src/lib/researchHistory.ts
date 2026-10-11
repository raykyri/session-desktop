// Browser-style visit history for the research surface's back/forward
// controls. One history covers every thread: each entry is the message
// selected in a thread (or Home, with no thread open), so switching between
// questions within a thread and across threads replays in the order it
// happened. A pure, immutable reducer: the app shell holds one
// `ResearchVisitHistory` value and swaps it for the result of these
// transitions, so the branch/cursor semantics live here and are unit-tested.

/** One step of research navigation. `home`: no thread open (the feed column
 * beside an empty content column). `node`: a thread with `nodeId` as its
 * deepest selected message; null until the thread page reports the message
 * it restored on opening. */
export type ResearchVisit =
  | { kind: "home" }
  | { kind: "node"; treeId: string; nodeId: string | null };

export interface ResearchVisitHistory {
  /** Visits, oldest first. */
  entries: ResearchVisit[];
  /** Cursor into `entries` for the visit on screen, or -1 when empty. */
  index: number;
}

interface ResearchVisitStep {
  history: ResearchVisitHistory;
  visit: ResearchVisit;
}

export const EMPTY_RESEARCH_VISITS: ResearchVisitHistory = { entries: [], index: -1 };

const RESEARCH_SWIPE_THRESHOLD_PX = 80;

/**
 * Resolves an accumulated two-axis wheel gesture into browser-style history
 * navigation. Horizontal intent must be clear before the distance threshold
 * counts, so diagonal/vertical scrolling does not accidentally change nodes.
 */
export function researchSwipeDirection(
  deltaX: number,
  deltaY: number,
): -1 | 0 | 1 {
  if (
    Math.abs(deltaX) < RESEARCH_SWIPE_THRESHOLD_PX ||
    Math.abs(deltaX) <= Math.abs(deltaY) * 1.25
  ) {
    return 0;
  }
  return deltaX < 0 ? -1 : 1;
}

/** Returns true if the wheel event represents horizontal swipe momentum. */
export function researchSwipeTailCapturesWheel(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) > Math.abs(deltaY);
}

/** The visit for what is on screen: a thread and its selected message, or
 * Home when no thread is open. */
export function researchVisitFor(treeId: string | null, nodeId: string | null): ResearchVisit {
  return treeId ? { kind: "node", treeId, nodeId } : { kind: "home" };
}

/** Starts a history at the given visit (the state restored at startup). */
export function initResearchVisits(visit: ResearchVisit | null): ResearchVisitHistory {
  return visit ? { entries: [visit], index: 0 } : EMPTY_RESEARCH_VISITS;
}

/** Seeds an empty history with the state restored at startup. A history the
 * reader already added to (by navigating before the restore finished) is
 * kept as it is. */
export function seedResearchVisits(
  history: ResearchVisitHistory,
  visit: ResearchVisit,
): ResearchVisitHistory {
  return history.index < 0 ? initResearchVisits(visit) : history;
}

/** Whether two visits show the same thing. A thread visit without a node
 * matches any visit to that thread: it stands for "the thread as it
 * restores", which the thread page fills in once it has opened. */
function sameResearchVisit(left: ResearchVisit, right: ResearchVisit): boolean {
  if (left.kind === "home" || right.kind === "home") {
    return left.kind === right.kind;
  }
  return (
    left.treeId === right.treeId &&
    (left.nodeId === null || right.nodeId === null || left.nodeId === right.nodeId)
  );
}

/** Of two matching visits, the one that names a node. */
function moreSpecificVisit(left: ResearchVisit, right: ResearchVisit): ResearchVisit {
  return left.kind === "node" && left.nodeId === null ? right : left;
}

/** The visit on screen, or null for an empty history. */
export function currentResearchVisit(history: ResearchVisitHistory): ResearchVisit | null {
  return history.index >= 0 ? (history.entries[history.index] ?? null) : null;
}

/**
 * Records fresh navigation to `visit`: entries beyond the cursor are
 * discarded, in this thread or any other, and the visit is appended — how a
 * browser drops the forward stack when you follow a new link. Navigating to
 * the visit already on screen changes nothing, except that a thread visit
 * without a node takes the node now named.
 */
export function pushResearchVisit(
  history: ResearchVisitHistory,
  visit: ResearchVisit,
): ResearchVisitHistory {
  const current = currentResearchVisit(history);
  if (current && sameResearchVisit(current, visit)) {
    const next = moreSpecificVisit(current, visit);
    return next === current ? history : replaceResearchVisit(history, next);
  }
  const entries = [...history.entries.slice(0, history.index + 1), visit];
  return { entries, index: entries.length - 1 };
}

/** Replaces the visit on screen without adding a step (a selection the
 * thread page made itself, e.g. the message it restored on opening). The
 * forward entries stay. A visit that now repeats its neighbour merges with
 * it. */
export function replaceResearchVisit(
  history: ResearchVisitHistory,
  visit: ResearchVisit,
): ResearchVisitHistory {
  if (history.index < 0) {
    return initResearchVisits(visit);
  }
  const current = history.entries[history.index];
  if (
    current.kind === visit.kind &&
    (current.kind === "home" ||
      (visit.kind === "node" && current.treeId === visit.treeId && current.nodeId === visit.nodeId))
  ) {
    return history;
  }
  const entries = [...history.entries];
  entries[history.index] = visit;
  return collapseResearchVisits(entries, history.index);
}

export function canGoResearchBack(history: ResearchVisitHistory): boolean {
  return history.index > 0;
}

export function canGoResearchForward(history: ResearchVisitHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/** Moves the cursor back one entry, or null if already at the start. */
export function researchVisitBack(history: ResearchVisitHistory): ResearchVisitStep | null {
  if (!canGoResearchBack(history)) {
    return null;
  }
  const index = history.index - 1;
  return { history: { entries: history.entries, index }, visit: history.entries[index] };
}

/** Moves the cursor forward one entry, or null if already at the end. */
export function researchVisitForward(history: ResearchVisitHistory): ResearchVisitStep | null {
  if (!canGoResearchForward(history)) {
    return null;
  }
  const index = history.index + 1;
  return { history: { entries: history.entries, index }, visit: history.entries[index] };
}

/** Merges adjacent matching entries, keeping the cursor on the entry that
 * held it. Stepping between two entries that show the same thing would
 * re-apply what is already on screen. */
function collapseResearchVisits(source: readonly ResearchVisit[], sourceIndex: number): ResearchVisitHistory {
  const entries: ResearchVisit[] = [];
  let index = -1;
  for (let at = 0; at < source.length; at += 1) {
    const visit = source[at];
    const previous = entries[entries.length - 1];
    if (previous && sameResearchVisit(previous, visit)) {
      entries[entries.length - 1] = moreSpecificVisit(previous, visit);
    } else {
      entries.push(visit);
    }
    if (at <= sourceIndex) {
      index = entries.length - 1;
    }
  }
  return entries.length === 0 ? EMPTY_RESEARCH_VISITS : { entries, index: Math.max(0, index) };
}

/** Removes visits that `keep` rejects (to a removed thread or message).
 * With `keepCurrent`, the visit on screen stays even when rejected: the
 * caller is still showing it and navigates away itself. Otherwise the cursor
 * moves to the nearest surviving visit before it (or the first one after).
 * Visits that become adjacent duplicates merge. Returns `history` itself
 * when nothing changed. */
export function pruneResearchVisits(
  history: ResearchVisitHistory,
  keep: (visit: ResearchVisit) => boolean,
  { keepCurrent = false }: { keepCurrent?: boolean } = {},
): ResearchVisitHistory {
  const kept: ResearchVisit[] = [];
  let keptIndex = -1;
  for (let at = 0; at < history.entries.length; at += 1) {
    const visit = history.entries[at];
    if (!keep(visit) && !(keepCurrent && at === history.index)) {
      continue;
    }
    kept.push(visit);
    if (at <= history.index) {
      keptIndex = kept.length - 1;
    }
  }
  const pruned = collapseResearchVisits(kept, keptIndex);
  if (
    pruned.index === history.index &&
    pruned.entries.length === history.entries.length &&
    pruned.entries.every((visit, at) => visit === history.entries[at])
  ) {
    return history;
  }
  return pruned;
}

/** History after messages of a thread were removed: their visits go, and
 * `selection` (the visit the thread page moved to) is on screen, so back and
 * forward keep matching what is open. */
export function researchVisitsAfterRemoval(
  history: ResearchVisitHistory,
  keep: (visit: ResearchVisit) => boolean,
  selection: ResearchVisit,
): ResearchVisitHistory {
  const pruned = pruneResearchVisits(history, keep);
  const current = currentResearchVisit(pruned);
  return current && sameResearchVisit(current, selection) && moreSpecificVisit(current, selection) === current
    ? pruned
    : pushResearchVisit(pruned, selection);
}

/** How the app shell shows a visit that back or forward moved to:
 * - `home`: close the open thread;
 * - `in-place`: select the message in the thread page already showing its
 *   thread (no remount, no refetch);
 * - `open-tree`: open the thread, restoring the visit's message. */
export function researchVisitAction(
  visit: ResearchVisit,
  activeTreeId: string | null,
  threadVisible: boolean,
): "home" | "in-place" | "open-tree" {
  if (visit.kind === "home") {
    return "home";
  }
  return threadVisible && activeTreeId === visit.treeId ? "in-place" : "open-tree";
}
