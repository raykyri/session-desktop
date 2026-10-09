// Research navigation restoration state (selected node and per-node scroll
// offsets, keyed by tree). Held as a module-level singleton so the workspace
// (which reads/writes selections) and the app shell (which prunes entries for
// deleted trees) mutate the same object — pruning localStorage behind a
// separate in-memory copy would just get resurrected by the next save.

import type { ResearchHighlightAnchor } from "../types";

interface SavedResearchScrollPosition {
  top: number;
  updatedAt: number;
}

/** An in-progress targeted follow-up (ask mode): the passage it is being
 * composed against and whatever the user has typed so far. Persisted so
 * leaving the research surface — which unmounts the document — does not
 * discard the ask; removed only by submit or an explicit dismiss. */
interface SavedResearchAsk {
  anchor: ResearchHighlightAnchor;
  text: string;
  updatedAt: number;
}

/** The conversation composer's draft. Unlike a targeted ask, this belongs
 * to the tree rather than a passage. */
interface SavedResearchFollowupDraft {
  text: string;
  updatedAt: number;
}

/** A follow-up submitted while its chain's tail was still running. It is
 * sent from the client when that tail completes. */
export interface QueuedResearchFollowup {
  id: string;
  prompt: string;
  createdAt: number;
  /** Why sending it failed. A failed question is not sent again until the
   * reader retries it; this is not restored on load, so a reload retries. */
  failed?: string;
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
  /** In-progress text in the conversation composer. */
  followupDraft?: SavedResearchFollowupDraft;
  /** A highlight to scroll into view on the next page visit (set when a
   * Highlights feed unit is opened). Cleared once the document lands on it. */
  focusHighlight?: { nodeId: string; highlightId: string };
  /** Branch chain heads pinned as columns beside the conversation, in order. */
  pinnedBranches?: string[];
  /** Queued follow-ups per chain, keyed by the chain's head node. */
  queuedFollowups?: Record<string, QueuedResearchFollowup[]>;
}

const RESEARCH_NAVIGATION_KEY = "session.research-navigation.v1";
export const RESEARCH_SCROLL_POSITION_TTL_MS = 15 * 60 * 1000;

let store: Record<string, SavedResearchNavigation> | null = null;

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
  // remains selectable when one of its terminal panes is currently visible.
  return !documentVisible || selectedTreeId !== nextTreeId;
}

function isSavedAnchor(value: unknown): value is ResearchHighlightAnchor {
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

function load(): Record<string, SavedResearchNavigation> {
  try {
    const now = Date.now();
    const parsed = JSON.parse(localStorage.getItem(RESEARCH_NAVIGATION_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([treeId, value]) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        const candidate = value as Partial<SavedResearchNavigation>;
        const scrollByNode = Object.fromEntries(
          Object.entries(candidate.scrollByNode ?? {}).flatMap(([nodeId, value]) => {
            if (!value || typeof value !== "object") {
              // The previous schema stored a bare number, which has no age and
              // therefore cannot safely be carried into the expiring cache.
              return [];
            }
            const position = value as Partial<SavedResearchScrollPosition>;
            return typeof position.top === "number" &&
              Number.isFinite(position.top) &&
              position.top >= 0 &&
              typeof position.updatedAt === "number" &&
              Number.isFinite(position.updatedAt) &&
              now - position.updatedAt < RESEARCH_SCROLL_POSITION_TTL_MS
              ? [[nodeId, { top: position.top, updatedAt: position.updatedAt }]]
              : [];
          }),
        );
        const expandedByNode = Object.fromEntries(
          Object.entries(candidate.expandedByNode ?? {}).filter(
            (entry): entry is [string, boolean] => entry[1] === true,
          ),
        );
        const askByNode = Object.fromEntries(
          Object.entries(candidate.askByNode ?? {}).flatMap(([nodeId, value]) => {
            if (!value || typeof value !== "object") {
              return [];
            }
            const ask = value as Partial<SavedResearchAsk>;
            return isSavedAnchor(ask.anchor) &&
              typeof ask.text === "string" &&
              typeof ask.updatedAt === "number" &&
              Number.isFinite(ask.updatedAt)
              ? [[nodeId, { anchor: ask.anchor, text: ask.text, updatedAt: ask.updatedAt }]]
              : [];
          }),
        );
        // Drafts saved before the composer lost its thread/branch mode still
        // carry a `mode`; only the text is kept.
        const followupDraft =
          candidate.followupDraft &&
          typeof candidate.followupDraft === "object" &&
          typeof candidate.followupDraft.text === "string" &&
          candidate.followupDraft.text.length > 0 &&
          typeof candidate.followupDraft.updatedAt === "number" &&
          Number.isFinite(candidate.followupDraft.updatedAt)
            ? {
                text: candidate.followupDraft.text,
                updatedAt: candidate.followupDraft.updatedAt,
              }
            : undefined;
        const focusHighlight =
          candidate.focusHighlight &&
          typeof candidate.focusHighlight === "object" &&
          typeof candidate.focusHighlight.nodeId === "string" &&
          typeof candidate.focusHighlight.highlightId === "string"
            ? {
                nodeId: candidate.focusHighlight.nodeId,
                highlightId: candidate.focusHighlight.highlightId,
              }
            : undefined;
        const pinnedBranches = Array.isArray(candidate.pinnedBranches)
          ? [...new Set(candidate.pinnedBranches.filter((id): id is string => typeof id === "string"))]
          : [];
        const queuedFollowups = Object.fromEntries(
          Object.entries(candidate.queuedFollowups ?? {}).flatMap(([headId, value]) => {
            if (!Array.isArray(value)) {
              return [];
            }
            const queue = value.flatMap((entry: unknown) => {
              const item = entry as Partial<QueuedResearchFollowup> | null;
              return item &&
                typeof item.id === "string" &&
                typeof item.prompt === "string" &&
                item.prompt.trim() &&
                typeof item.createdAt === "number" &&
                Number.isFinite(item.createdAt)
                ? [{ id: item.id, prompt: item.prompt, createdAt: item.createdAt }]
                : [];
            });
            return queue.length > 0 ? [[headId, queue]] : [];
          }),
        );
        return [[treeId, {
          selectedNodeId:
            typeof candidate.selectedNodeId === "string" ? candidate.selectedNodeId : undefined,
          scrollByNode,
          ...(Object.keys(expandedByNode).length > 0 ? { expandedByNode } : {}),
          ...(Object.keys(askByNode).length > 0 ? { askByNode } : {}),
          ...(followupDraft ? { followupDraft } : {}),
          ...(focusHighlight ? { focusHighlight } : {}),
          ...(pinnedBranches.length > 0 ? { pinnedBranches } : {}),
          ...(Object.keys(queuedFollowups).length > 0 ? { queuedFollowups } : {}),
        } satisfies SavedResearchNavigation]];
      }),
    );
  } catch {
    return {};
  }
}

export function researchNavigationStore(): Record<string, SavedResearchNavigation> {
  return (store ??= load());
}

export function saveResearchNavigation(): void {
  try {
    localStorage.setItem(RESEARCH_NAVIGATION_KEY, JSON.stringify(researchNavigationStore()));
  } catch {
    // Navigation restoration is a convenience; storage denial must not break research.
  }
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

/** Updates the conversation composer's draft and reports whether the stored
 * value changed. Empty text removes the saved draft so it cannot be restored
 * after sending or clearing the composer. */
export function recordResearchFollowupDraft(
  navigation: SavedResearchNavigation,
  text: string,
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
  if (existing && existing.text === text) {
    return false;
  }
  navigation.followupDraft = { text, updatedAt: now };
  return true;
}

/** Drops navigation state for trees that no longer exist. */
export function pruneResearchNavigation(validTreeIds: Iterable<string>): void {
  const valid = new Set(validTreeIds);
  const current = researchNavigationStore();
  let changed = false;
  for (const treeId of Object.keys(current)) {
    if (!valid.has(treeId)) {
      delete current[treeId];
      changed = true;
    }
  }
  if (changed) {
    saveResearchNavigation();
  }
}

/** Drops per-node state (scroll offsets, selection) for deleted nodes of a tree. */
export function pruneResearchNavigationNodes(treeId: string, validNodeIds: Iterable<string>): void {
  const navigation = researchNavigationStore()[treeId];
  if (!navigation) {
    return;
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
  if (navigation.pinnedBranches?.some((nodeId) => !valid.has(nodeId))) {
    navigation.pinnedBranches = navigation.pinnedBranches.filter((nodeId) => valid.has(nodeId));
    changed = true;
  }
  for (const headId of Object.keys(navigation.queuedFollowups ?? {})) {
    if (!valid.has(headId)) {
      delete navigation.queuedFollowups?.[headId];
      changed = true;
    }
  }
  if (navigation.selectedNodeId && !valid.has(navigation.selectedNodeId)) {
    delete navigation.selectedNodeId;
    changed = true;
  }
  if (changed) {
    saveResearchNavigation();
  }
}
