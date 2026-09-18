// Research navigation restoration state: the selected node, per-node scroll
// offsets and expansion flags, in-progress asks and composer drafts, keyed by
// tree.
//
// Ported from the desktop `src/lib/researchNavigation.ts` minus its storage
// layer. The desktop held one module-level singleton hydrated from
// localStorage; `shared` has no storage, so only the value semantics live
// here: every function takes the record it operates on and either returns a
// value or reports whether the record changed. The client owns the store, its
// hydration (using `isSavedResearchAnchor` to validate persisted anchors) and
// its persistence.

import type { ResearchHighlightAnchor } from "../types/research.js";

export interface SavedResearchScrollPosition {
  top: number;
  updatedAt: number;
}

/** An in-progress targeted follow-up (ask mode): the passage it is being
 * composed against and whatever the user has typed so far. Persisted so
 * leaving the research surface — which unmounts the document — does not
 * discard the ask; removed only by submit or an explicit dismiss. */
export interface SavedResearchAsk {
  anchor: ResearchHighlightAnchor;
  text: string;
  updatedAt: number;
}

/** The ordinary thread/branch composer draft. Unlike a targeted ask, this
 * belongs to the tree's currently restored page rather than a passage. */
export interface SavedResearchFollowupDraft {
  text: string;
  mode: "thread" | "branch";
  updatedAt: number;
}

export interface SavedResearchNavigation {
  selectedNodeId?: string;
  scrollByNode: Record<string, SavedResearchScrollPosition>;
  /** Nodes whose "Show earlier" window the user expanded. Restored together
   * with the scroll offset — an offset captured against the expanded list
   * would land in the wrong place in the collapsed one. */
  expandedByNode?: Record<string, boolean>;
  /** In-progress asks, keyed by the node they were started on. */
  askByNode?: Record<string, SavedResearchAsk>;
  /** In-progress text in the ordinary thread/branch composer. */
  followupDraft?: SavedResearchFollowupDraft;
  /** A highlight to scroll into view on the next page visit (set when a
   * Highlights feed unit is opened). Cleared once the document lands on it. */
  focusHighlight?: { nodeId: string; highlightId: string };
}

export const RESEARCH_SCROLL_POSITION_TTL_MS = 15 * 60 * 1000;

export function isResearchNodeSelectionChange(
  selectedNodeId: string | null,
  nextNodeId: string,
): boolean {
  return selectedNodeId !== nextNodeId;
}

export function isResearchTreeSelectionChange(
  selectedTreeId: string | null,
  documentVisible: boolean,
  nextTreeId: string,
): boolean {
  // Re-selecting the visible document would clear its detail while the same
  // tree is fetched again, producing a needless loading blink. The same tree
  // remains selectable when its document is not the visible page.
  return !documentVisible || selectedTreeId !== nextTreeId;
}

/** Whether a persisted value is still a usable highlight anchor. Restoration
 * state is written by an older build as often as the current one, so the
 * client validates every anchor it reads back before handing it to the ask
 * composer. */
export function isSavedResearchAnchor(value: unknown): value is ResearchHighlightAnchor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const anchor = value as Partial<ResearchHighlightAnchor>;
  return (
    anchor.version === 1 &&
    anchor.projection === "answer-v1" &&
    typeof anchor.responseRevision === "string" &&
    typeof anchor.start === "number" &&
    typeof anchor.end === "number" &&
    typeof anchor.exact === "string" &&
    typeof anchor.prefix === "string" &&
    typeof anchor.suffix === "string"
  );
}

export function recordResearchScrollPosition(
  navigation: SavedResearchNavigation,
  nodeId: string,
  top: number,
  now = Date.now(),
): void {
  navigation.scrollByNode[nodeId] = { top, updatedAt: now };
}

export function restoreResearchScrollPosition(
  navigation: SavedResearchNavigation | undefined,
  nodeId: string,
  now = Date.now(),
): number {
  const position = navigation?.scrollByNode[nodeId];
  if (!position || now - position.updatedAt >= RESEARCH_SCROLL_POSITION_TTL_MS) {
    return 0;
  }
  return position.top;
}

/** Updates the ordinary composer draft and reports whether the stored value
 * changed. Empty text removes the draft so successful sends and manual clears
 * do not resurrect an empty composer mode. */
export function recordResearchFollowupDraft(
  navigation: SavedResearchNavigation,
  text: string,
  mode: SavedResearchFollowupDraft["mode"],
  now = Date.now(),
): boolean {
  if (text.length === 0) {
    if (!navigation.followupDraft) {
      return false;
    }
    delete navigation.followupDraft;
    return true;
  }
  const existing = navigation.followupDraft;
  if (existing && existing.text === text && existing.mode === mode) {
    return false;
  }
  navigation.followupDraft = { text, mode, updatedAt: now };
  return true;
}

/** Drops navigation state for trees that no longer exist, reporting whether
 * the record changed so the caller can skip a write. */
export function pruneResearchNavigation(
  navigationByTree: Record<string, SavedResearchNavigation>,
  validTreeIds: Iterable<string>,
): boolean {
  const valid = new Set(validTreeIds);
  let changed = false;
  for (const treeId of Object.keys(navigationByTree)) {
    if (!valid.has(treeId)) {
      delete navigationByTree[treeId];
      changed = true;
    }
  }
  return changed;
}

/** Drops per-node state (scroll offsets, expansion, asks, selection) for
 * deleted nodes of one tree, reporting whether the record changed. */
export function pruneResearchNavigationNodes(
  navigation: SavedResearchNavigation | undefined,
  validNodeIds: Iterable<string>,
): boolean {
  if (!navigation) {
    return false;
  }
  const valid = new Set(validNodeIds);
  let changed = false;
  for (const nodeId of Object.keys(navigation.scrollByNode)) {
    if (!valid.has(nodeId)) {
      delete navigation.scrollByNode[nodeId];
      changed = true;
    }
  }
  for (const nodeId of Object.keys(navigation.expandedByNode ?? {})) {
    if (!valid.has(nodeId)) {
      delete navigation.expandedByNode?.[nodeId];
      changed = true;
    }
  }
  for (const nodeId of Object.keys(navigation.askByNode ?? {})) {
    if (!valid.has(nodeId)) {
      delete navigation.askByNode?.[nodeId];
      changed = true;
    }
  }
  if (navigation.selectedNodeId && !valid.has(navigation.selectedNodeId)) {
    delete navigation.selectedNodeId;
    changed = true;
  }
  return changed;
}
