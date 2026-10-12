// Browser-style history for research navigation. Entries record Home or the
// selected message in a thread. These pure functions update the shared stack.

/** One step of research navigation. `home`: no thread open (the feed column
 * beside an empty content column). `node`: a thread with `nodeId` as its
 * deepest selected message; null until the thread page reports the message
 * it restored on opening. `path`, when given, is each column's selected
 * message, root column first, ending with `nodeId`; without it the levels
 * `nodeId` was asked from open with it. */
export type ResearchVisit =
  | { kind: "home" }
  | { kind: "node"; treeId: string; nodeId: string | null; path?: readonly string[] };

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Lenient: a visit without a path matches any path. */
const samePath = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
  !left || !right || sameIds(left, right);

/** Strict: both visits name the same path, or neither names one. */
const samePathExactly = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
  left && right ? sameIds(left, right) : !left && !right;

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

/** Seeds an empty history with restored state. Existing navigation takes precedence. */
export function seedResearchVisits(
  history: ResearchVisitHistory,
  visit: ResearchVisit,
): ResearchVisitHistory {
  return history.index < 0 ? initResearchVisits(visit) : history;
}

/** Compares visits. A thread visit without a node matches any visit to
 * that thread. With `exactPath`, visits to the same node match only when
 * they name the same path (or neither names one); otherwise a visit without
 * a path matches any path. */
function sameResearchVisit(left: ResearchVisit, right: ResearchVisit, exactPath = false): boolean {
  if (left.kind === "home" || right.kind === "home") {
    return left.kind === right.kind;
  }
  return (
    left.treeId === right.treeId &&
    (left.nodeId === null ||
      right.nodeId === null ||
      (left.nodeId === right.nodeId &&
        (exactPath ? samePathExactly(left.path, right.path) : samePath(left.path, right.path))))
  );
}

/** Of two matching visits, the one that names a node, then the one that
 * names every column's selection. */
function moreSpecificVisit(left: ResearchVisit, right: ResearchVisit): ResearchVisit {
  if (left.kind !== "node" || right.kind !== "node") {
    return left;
  }
  return left.nodeId === null || (!left.path && right.path && right.nodeId !== null) ? right : left;
}

/** The visit on screen, or null for an empty history. */
export function currentResearchVisit(history: ResearchVisitHistory): ResearchVisit | null {
  return history.index >= 0 ? (history.entries[history.index] ?? null) : null;
}

/**
 * Records fresh navigation to `visit`: entries beyond the cursor are
 * discarded and the visit is appended. Navigating to the current visit changes
 * nothing, except that a thread visit without a node adopts the specified node.
 * Visits to the same node with different paths, or with a path and without
 * one, are different steps.
 */
export function pushResearchVisit(
  history: ResearchVisitHistory,
  visit: ResearchVisit,
): ResearchVisitHistory {
  const current = currentResearchVisit(history);
  if (current && sameResearchVisit(current, visit, true)) {
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
      (visit.kind === "node" &&
        current.treeId === visit.treeId &&
        current.nodeId === visit.nodeId &&
        samePathExactly(current.path, visit.path)))
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

/** Merges adjacent matching entries and preserves the cursor position. */
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

/** Rewrites the visits: `update` returns a visit's replacement (the visit
 * itself to keep it unchanged) or null to remove it. With `keepCurrent`,
 * the visit on screen stays as it is even when `update` changes it: the
 * caller is still showing it and navigates away itself. When the visit on
 * screen is removed, the cursor moves to the nearest surviving visit before
 * it (or the first one after). Visits that become adjacent duplicates merge.
 * Returns `history` itself when nothing changed. */
export function mapResearchVisits(
  history: ResearchVisitHistory,
  update: (visit: ResearchVisit) => ResearchVisit | null,
  { keepCurrent = false }: { keepCurrent?: boolean } = {},
): ResearchVisitHistory {
  const kept: ResearchVisit[] = [];
  let keptIndex = -1;
  for (let at = 0; at < history.entries.length; at += 1) {
    const visit = history.entries[at];
    const updated = keepCurrent && at === history.index ? visit : update(visit);
    if (!updated) {
      continue;
    }
    kept.push(updated);
    if (at <= history.index) {
      keptIndex = kept.length - 1;
    }
  }
  const mapped = collapseResearchVisits(kept, keptIndex);
  if (
    mapped.index === history.index &&
    mapped.entries.length === history.entries.length &&
    mapped.entries.every((visit, at) => visit === history.entries[at])
  ) {
    return history;
  }
  return mapped;
}

/** Removes visits that `keep` rejects (to a removed thread or message); see
 * mapResearchVisits. */
export function pruneResearchVisits(
  history: ResearchVisitHistory,
  keep: (visit: ResearchVisit) => boolean,
  options: { keepCurrent?: boolean } = {},
): ResearchVisitHistory {
  return mapResearchVisits(history, (visit) => (keep(visit) ? visit : null), options);
}

/** A visit after messages of thread `treeId` were removed (`keepNode`
 * rejects them). A visit that selects only remaining messages is unchanged.
 * A visit with a path that selects a removed message gets the path
 * `survivingPath` makes of it (see researchSelectionAfterRemoval), and is
 * removed when that is empty. A visit without a path is removed with its
 * message. */
export function researchVisitAfterRemoval(
  visit: ResearchVisit,
  treeId: string,
  keepNode: (nodeId: string) => boolean,
  survivingPath: (path: readonly string[]) => readonly string[],
): ResearchVisit | null {
  if (visit.kind === "home" || visit.treeId !== treeId || visit.nodeId === null) {
    return visit;
  }
  if (!visit.path) {
    return keepNode(visit.nodeId) ? visit : null;
  }
  if (visit.path.every(keepNode)) {
    return visit;
  }
  const path = survivingPath(visit.path);
  const nodeId = path[path.length - 1];
  return nodeId ? { kind: "node", treeId, nodeId, path: [...path] } : null;
}

/** History after messages of a thread were removed: `update` rewrites or
 * removes each visit (see researchVisitAfterRemoval), and `selection` (the
 * visit the thread page moved to) is on screen, so back and forward keep
 * matching what is open. When the visit on screen is to the same message,
 * `selection` replaces it; otherwise it is pushed. */
export function researchVisitsAfterRemoval(
  history: ResearchVisitHistory,
  update: (visit: ResearchVisit) => ResearchVisit | null,
  selection: ResearchVisit,
): ResearchVisitHistory {
  const mapped = mapResearchVisits(history, update);
  const current = currentResearchVisit(mapped);
  if (
    current?.kind === "node" &&
    selection.kind === "node" &&
    current.treeId === selection.treeId &&
    (current.nodeId === null || current.nodeId === selection.nodeId)
  ) {
    // A selection without a path keeps the path the visit on screen names.
    return !selection.path && current.path ? mapped : replaceResearchVisit(mapped, selection);
  }
  return pushResearchVisit(mapped, selection);
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
