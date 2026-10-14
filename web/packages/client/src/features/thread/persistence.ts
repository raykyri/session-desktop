// What a thread page keeps per tree across visits and reloads
// (`09-research-document-view.md` §4), ported from the desktop
// `researchNavigation.ts` store and `researchThreadPersistence.ts`. The
// selection itself is in the URL (`?sel=`); the store keeps the last one so a
// thread opened without it opens where it was left, and the per-column scroll
// offsets, "Show earlier" expansions and the unsent branch, which do not
// belong in the URL.
//
// One module-level store per page, so every thread page mount and the pruning
// on removal mutate the same object; writes share one debounce and a flush on
// `pagehide`.

import type { ResearchHighlightAnchor } from "@session/shared";
import { isSavedResearchAnchor, RESEARCH_SCROLL_POSITION_TTL_MS } from "@session/shared";
import type { ResearchScrollKind } from "@session/shared/lib/researchColumns";

export const THREAD_NAVIGATION_KEY = "session.thread-navigation.v1";
const SAVE_DEBOUNCE_MS = 250;
/** How many trees the store keeps; the least recently written go first. */
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
  /** The unsent branch on a passage, keyed by its parent message. */
  pendingBranches?: Record<string, SavedPendingBranch>;
  /** A highlight to reveal on the next visit (opened from Highlights). */
  focusHighlight?: { nodeId: string; highlightId: string };
  updatedAt: number;
}

let store: Record<string, ThreadNavigation> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const emptyScroll = (): ThreadNavigation["scroll"] => ({ answer: {}, messages: {}, branches: {} });

function load(): Record<string, ThreadNavigation> {
  try {
    const parsed = JSON.parse(localStorage.getItem(THREAD_NAVIGATION_KEY) ?? "{}") as unknown;
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

/** The store, loaded on first use. */
export function threadNavigationStore(): Record<string, ThreadNavigation> {
  store ??= load();
  return store;
}

/** Writes the store now. */
export function flushThreadNavigation(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!store) return;
  const entries = Object.entries(store)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TREES);
  try {
    localStorage.setItem(THREAD_NAVIGATION_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable or full: the state lasts until the page reloads.
  }
}

/** `pagehide` writes a save the debounce still holds: the timer would not
 * fire once the page is unloading or entering the back/forward cache. */
export function flushPendingThreadNavigation(): void {
  if (timer !== null) flushThreadNavigation();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingThreadNavigation);
}

function scheduleSave(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushThreadNavigation, SAVE_DEBOUNCE_MS);
}

/** The tree's entry, created on first write. */
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

/** Asks the next visit to `treeId` to reveal a highlight. */
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

/** Drops per-node state for messages no longer in the tree. */
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

/** Forgets a tree (it was deleted). */
export function forgetThread(treeId: string): void {
  const all = threadNavigationStore();
  if (!all[treeId]) return;
  delete all[treeId];
  flushThreadNavigation();
}

/** For tests: drops the in-memory store so the next read loads storage. */
export function resetThreadNavigationForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  store = null;
}
