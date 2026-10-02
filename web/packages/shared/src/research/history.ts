// Browser-style visit history for the research document's back/forward
// controls. A pure, immutable reducer: the client holds one `ResearchHistory`
// value and swaps it for the result of these transitions, so the branch/cursor
// semantics live here (and are unit-tested) rather than inline in the view.

export interface ResearchHistory {
  /** Visited node ids, oldest first. */
  entries: string[];
  /** Cursor into `entries` for the currently displayed node, or -1 when empty. */
  index: number;
}

export interface ResearchHistoryStep {
  history: ResearchHistory;
  nodeId: string;
}

export const EMPTY_RESEARCH_HISTORY: ResearchHistory = { entries: [], index: -1 };

/** Starts a fresh history at the given entry node (e.g. on a tree switch). */
export function initResearchHistory(nodeId: string | null): ResearchHistory {
  return nodeId ? { entries: [nodeId], index: 0 } : EMPTY_RESEARCH_HISTORY;
}

/**
 * Records fresh navigation to `nodeId`: any forward entries beyond the cursor
 * are discarded and the node is appended, leaving the cursor at the end —
 * exactly how a browser drops the forward stack when you follow a new link.
 */
export function pushResearchHistory(history: ResearchHistory, nodeId: string): ResearchHistory {
  const entries = [...history.entries.slice(0, history.index + 1), nodeId];
  return { entries, index: entries.length - 1 };
}

export function canGoBack(history: ResearchHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: ResearchHistory): boolean {
  return history.index < history.entries.length - 1;
}

/** Moves the cursor back one entry, or null if already at the start. */
export function researchHistoryBack(history: ResearchHistory): ResearchHistoryStep | null {
  if (!canGoBack(history)) {
    return null;
  }
  const index = history.index - 1;
  const nodeId = history.entries[index];
  // `canGoBack` puts the index inside the entry list; the guard only narrows.
  if (nodeId === undefined) {
    return null;
  }
  return { history: { entries: history.entries, index }, nodeId };
}

/** Moves the cursor forward one entry, or null if already at the end. */
export function researchHistoryForward(history: ResearchHistory): ResearchHistoryStep | null {
  if (!canGoForward(history)) {
    return null;
  }
  const index = history.index + 1;
  const nodeId = history.entries[index];
  // `canGoForward` puts the index inside the entry list; the guard only narrows.
  if (nodeId === undefined) {
    return null;
  }
  return { history: { entries: history.entries, index }, nodeId };
}

/** Removes visits to nodes that no longer exist while keeping the cursor on
 * the same surviving visit whenever possible. Visits that become adjacent
 * duplicates are collapsed: stepping between two entries for the same node
 * would re-apply the already-selected node, which readers treat as a real
 * navigation (e.g. clearing content for a load that never restarts). */
export function pruneResearchHistory(
  history: ResearchHistory,
  validNodeIds: ReadonlySet<string>,
  fallbackNodeId: string | null,
): ResearchHistory {
  const entries: string[] = [];
  let index = -1;
  for (let visit = 0; visit < history.entries.length; visit += 1) {
    const nodeId = history.entries[visit];
    if (nodeId === undefined || !validNodeIds.has(nodeId)) {
      continue;
    }
    if (entries[entries.length - 1] !== nodeId) {
      entries.push(nodeId);
    }
    if (visit <= history.index) {
      index = entries.length - 1;
    }
  }
  if (entries.length === 0) {
    return initResearchHistory(fallbackNodeId);
  }
  return { entries, index: Math.max(0, index) };
}
