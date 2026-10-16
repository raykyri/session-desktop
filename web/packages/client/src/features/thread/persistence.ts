// Persisted per-tree navigation state across visits and page reloads
// (`09-research-document-view.md` §4), adapted from desktop
// `researchNavigation.ts` and `researchThreadPersistence.ts`. Selection state
// is encoded in the URL query (`?sel=`); this store caches the last known selection
// path when a thread is opened without explicit query parameters, alongside per-column
// scroll offsets, "Show earlier" expansion states, and unsubmitted pending branches.
//
// A module-level store coordinates mutations across thread page mounts and node pruning.
// Storage writes share a 250 ms debounce and flush on `pagehide`. Cross-tab writes
// sharing the storage key merge on a per-tree basis using last-write-wins timestamps
// (`lib/tabMerge.js`) upon receiving `storage` events.
//
// Pending branch drafts belong to the authenticated user. The store is cleared on
// sign-out, session expiration, or account mismatch (`stores/localAccount.ts`), and tabs
// without valid ownership (`lib/localOwner.ts`) do not persist changes.

import type { ResearchHighlightAnchor } from "@session/shared";
import { isSavedResearchAnchor, RESEARCH_SCROLL_POSITION_TTL_MS } from "@session/shared";
import type { ResearchScrollKind } from "@session/shared/lib/researchColumns";

import { ownsLocalState } from "../../lib/localOwner.js";
import { mergeByUpdatedAt, onOtherTabWrite } from "../../lib/tabMerge.js";

export const THREAD_NAVIGATION_KEY = "session.thread-navigation.v1";
const SAVE_DEBOUNCE_MS = 250;
/** Maximum number of trees retained in storage; least recently updated entries are evicted. */
const MAX_TREES = 200;

interface SavedScroll {
  top: number;
  updatedAt: number;
}

export interface SavedPendingBranch {
  anchor: ResearchHighlightAnchor;
  text: string;
  updatedAt: number;
}

export interface ThreadNavigation {
  /** Each column's selected message, root column first. */
  selectionPath?: string[];
  scroll: Record<ResearchScrollKind, Record<string, SavedScroll>>;
  /** Answers whose "Show earlier" window was expanded. */
  expandedByNode?: Record<string, true>;
  /** Unsubmitted pending branch drafts anchored to a passage, keyed by parent node ID. */
  pendingBranches?: Record<string, SavedPendingBranch>;
  /** Highlight identifier to reveal on subsequent visits (navigated from Highlights view). */
  focusHighlight?: { nodeId: string; highlightId: string };
  updatedAt: number;
}

let store: Record<string, ThreadNavigation> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Tree IDs deleted in this tab with deletion timestamps, preventing resurrection
 * during cross-tab merge until written. */
const forgotten = new Map<string, number>();

const emptyScroll = (): ThreadNavigation["scroll"] => ({ answer: {}, messages: {}, branches: {} });

function load(): Record<string, ThreadNavigation> {
  try {
    return parse(localStorage.getItem(THREAD_NAVIGATION_KEY));
  } catch {
    return {};
  }
}

function parse(text: string | null): Record<string, ThreadNavigation> {
  try {
    const parsed = JSON.parse(text ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const result: Record<string, ThreadNavigation> = {};
    for (const [treeId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Partial<ThreadNavigation>;
      const entry: ThreadNavigation = {
        scroll: emptyScroll(),
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
      };
      if (Array.isArray(value.selectionPath)) {
        entry.selectionPath = value.selectionPath.filter(
          (id): id is string => typeof id === "string",
        );
      }
      for (const kind of ["answer", "messages", "branches"] as const) {
        const positions = value.scroll?.[kind];
        if (!positions || typeof positions !== "object") continue;
        for (const [key, position] of Object.entries(positions)) {
          if (
            position &&
            typeof position.top === "number" &&
            typeof position.updatedAt === "number" &&
            now - position.updatedAt < RESEARCH_SCROLL_POSITION_TTL_MS
          ) {
            entry.scroll[kind][key] = position;
          }
        }
      }
      if (value.expandedByNode && typeof value.expandedByNode === "object") {
        entry.expandedByNode = { ...value.expandedByNode };
      }
      if (value.pendingBranches && typeof value.pendingBranches === "object") {
        for (const [nodeId, branch] of Object.entries(value.pendingBranches)) {
          if (branch && isSavedResearchAnchor(branch.anchor) && typeof branch.text === "string") {
            (entry.pendingBranches ??= {})[nodeId] = branch;
          }
        }
      }
      if (
        value.focusHighlight &&
        typeof value.focusHighlight.nodeId === "string" &&
        typeof value.focusHighlight.highlightId === "string"
      ) {
        entry.focusHighlight = value.focusHighlight;
      }
      result[treeId] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

/** Returns the in-memory store, initializing from localStorage on first access. */
export function threadNavigationStore(): Record<string, ThreadNavigation> {
  // Unauthenticated tabs or tabs mismatched with stored account ownership
  // initialize with empty state to prevent cross-account data leaks.
  store ??= ownsLocalState() ? load() : {};
  return store;
}

/** Persists navigation state to localStorage immediately, merging concurrent cross-tab updates. */
export function flushThreadNavigation(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!store) return;
  if (!ownsLocalState()) return;
  store = mergeByUpdatedAt(store, load(), forgotten);
  forgotten.clear();
  const entries = Object.entries(store)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TREES);
  try {
    localStorage.setItem(THREAD_NAVIGATION_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable or full; state is retained in memory until page reload.
  }
}

/** Flushes debounced writes during `pagehide` before page unload or back-forward cache entry. */
export function flushPendingThreadNavigation(): void {
  if (timer !== null) flushThreadNavigation();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingThreadNavigation);
}

// Synchronize updates written by other tabs.
onOtherTabWrite(THREAD_NAVIGATION_KEY, (value) => {
  if (store) store = mergeByUpdatedAt(store, parse(value), forgotten);
});

function scheduleSave(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushThreadNavigation, SAVE_DEBOUNCE_MS);
}

/** Retrieves or initializes the navigation state entry for a tree. */
export function threadNavigation(treeId: string): ThreadNavigation {
  const all = threadNavigationStore();
  const entry = (all[treeId] ??= { scroll: emptyScroll(), updatedAt: Date.now() });
  return entry;
}

function touched(treeId: string): ThreadNavigation {
  const entry = threadNavigation(treeId);
  entry.updatedAt = Date.now();
  return entry;
}

export function savedSelection(treeId: string): readonly string[] | null {
  const path = threadNavigationStore()[treeId]?.selectionPath;
  return path && path.length > 0 ? path : null;
}

export function recordSelection(treeId: string, path: readonly string[]): void {
  const entry = threadNavigation(treeId);
  const current = entry.selectionPath ?? [];
  if (current.length === path.length && current.every((id, index) => id === path[index])) return;
  touched(treeId).selectionPath = [...path];
  scheduleSave();
}

export function savedScroll(treeId: string, kind: ResearchScrollKind, key: string): number {
  const position = threadNavigationStore()[treeId]?.scroll[kind][key];
  if (!position || Date.now() - position.updatedAt >= RESEARCH_SCROLL_POSITION_TTL_MS) return 0;
  return position.top;
}

export function recordScroll(
  treeId: string,
  kind: ResearchScrollKind,
  key: string,
  top: number,
): void {
  touched(treeId).scroll[kind][key] = { top, updatedAt: Date.now() };
  scheduleSave();
}

export function expandedNodes(treeId: string): Record<string, true> {
  return { ...threadNavigationStore()[treeId]?.expandedByNode };
}

export function recordExpanded(treeId: string, nodeId: string): void {
  (touched(treeId).expandedByNode ??= {})[nodeId] = true;
  scheduleSave();
}

export function savedPendingBranch(treeId: string, nodeId: string): SavedPendingBranch | null {
  return threadNavigationStore()[treeId]?.pendingBranches?.[nodeId] ?? null;
}

export function recordPendingBranch(
  treeId: string,
  nodeId: string,
  anchor: ResearchHighlightAnchor,
  text: string,
): void {
  (touched(treeId).pendingBranches ??= {})[nodeId] = { anchor, text, updatedAt: Date.now() };
  scheduleSave();
}

export function clearPendingBranch(treeId: string, nodeId: string): void {
  const branches = threadNavigationStore()[treeId]?.pendingBranches;
  if (!branches?.[nodeId]) return;
  delete branches[nodeId];
  flushThreadNavigation();
}

/** Requests highlight focus for the next navigation to `treeId`. */
export function requestHighlightFocus(treeId: string, nodeId: string, highlightId: string): void {
  touched(treeId).focusHighlight = { nodeId, highlightId };
  flushThreadNavigation();
}

export function focusHighlightOf(treeId: string): { nodeId: string; highlightId: string } | null {
  return threadNavigationStore()[treeId]?.focusHighlight ?? null;
}

export function clearHighlightFocus(treeId: string): void {
  const entry = threadNavigationStore()[treeId];
  if (!entry?.focusHighlight) return;
  delete entry.focusHighlight;
  flushThreadNavigation();
}

/** Removes navigation state entries for node IDs no longer present in the tree. */
export function pruneThreadNavigation(treeId: string, validNodeIds: ReadonlySet<string>): void {
  const entry = threadNavigationStore()[treeId];
  if (!entry) return;
  let changed = false;
  for (const kind of ["answer", "messages", "branches"] as const) {
    for (const key of Object.keys(entry.scroll[kind])) {
      if (!validNodeIds.has(key)) {
        delete entry.scroll[kind][key];
        changed = true;
      }
    }
  }
  for (const key of Object.keys(entry.expandedByNode ?? {})) {
    if (!validNodeIds.has(key)) {
      delete entry.expandedByNode?.[key];
      changed = true;
    }
  }
  for (const key of Object.keys(entry.pendingBranches ?? {})) {
    if (!validNodeIds.has(key)) {
      delete entry.pendingBranches?.[key];
      changed = true;
    }
  }
  if (entry.selectionPath?.some((id) => !validNodeIds.has(id))) {
    delete entry.selectionPath;
    changed = true;
  }
  if (changed) scheduleSave();
}

/** Deletes navigation state for a removed tree. */
export function forgetThread(treeId: string): void {
  const all = threadNavigationStore();
  if (!all[treeId]) return;
  delete all[treeId];
  forgotten.set(treeId, Date.now());
  flushThreadNavigation();
}

/** Clears in-memory navigation state for all trees, optionally clearing localStorage. */
export function dropThreadNavigation(stored: boolean): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  store = null;
  forgotten.clear();
  if (!stored) return;
  try {
    localStorage.removeItem(THREAD_NAVIGATION_KEY);
  } catch {
    // Storage unavailable; no persisted state to remove.
  }
}

/** Resets the in-memory store for test isolation so subsequent calls reload from storage. */
export function resetThreadNavigationForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  store = null;
  forgotten.clear();
}
