// Page chrome state that does not belong in the URL (07 §4.3, §8): the
// sidebar's width and collapsed state, and the feeds' scroll
// anchors. Tabs share the storage key; the anchors are merged feed by feed
// on each write and when another tab writes (`lib/tabMerge`), so one tab
// does not replace another's anchors for feeds it never scrolled.
//
// History is browser history (ADR-7): a thread's selection is its `?sel=`
// search parameter, and what a thread keeps per tree across visits (scroll
// offsets, expansions, the unsent branch) is in
// `features/thread/persistence.ts`.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { mergeByUpdatedAt, onOtherTabWrite } from "../lib/tabMerge.js";

export const NAVIGATION_STORAGE_KEY = "session.navigation.v2";

export type FeedMode = "all" | "workspace";

export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 268;

/** Below this the sidebar stops being a column and becomes a drawer (08 §7). */
export const NARROW_LAYOUT_WIDTH = 900;

/** Where a feed was left: the id of the row under the viewport's top edge and
 * its pixel offset from it (`10` §2), plus the scroller's `scrollTop`. Keyed
 * by feed — each feed scope scrolls independently. `top` is the restore
 * path; key+offset still describe the visible row if the list shifted. */
export interface FeedScrollAnchor {
  key: string;
  offset: number;
  /** Scroller `scrollTop` when the feed was left. Older persisted anchors
   * omit it and fall back to key+offset. */
  top?: number;
  /** When it was recorded, for merging with other tabs' anchors. */
  updatedAt?: number;
}

export interface NavigationState {
  feedAnchorByView: Record<string, FeedScrollAnchor>;
  sidebarCollapsed: boolean;
  sidebarWidth: number;

  recordFeedAnchor: (view: string, anchor: FeedScrollAnchor | null) => void;
  feedAnchorFor: (view: string) => FeedScrollAnchor | null;

  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
}

function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
}

/** Feeds whose anchor this tab dropped, with when, until the next write. */
const droppedAnchors = new Map<string, number>();

type Anchors = Record<string, FeedScrollAnchor>;

function storedAnchors(text: string | null): Anchors | null {
  try {
    const parsed = JSON.parse(text ?? "null") as { state?: { feedAnchorByView?: unknown } } | null;
    const anchors = parsed?.state?.feedAnchorByView;
    return anchors && typeof anchors === "object" ? (anchors as Anchors) : null;
  } catch {
    return null;
  }
}

function sameAnchors(left: Anchors, right: Anchors): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const a = left[key];
    const b = right[key];
    return (
      a !== undefined &&
      b !== undefined &&
      a.key === b.key &&
      a.offset === b.offset &&
      a.top === b.top &&
      a.updatedAt === b.updatedAt
    );
  });
}

/** localStorage, with the anchors of the value merged with the stored ones
 * before each write. */
const mergingStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    let text = value;
    try {
      const next = JSON.parse(value) as { state?: { feedAnchorByView?: Anchors } };
      const stored = storedAnchors(localStorage.getItem(name));
      if (next.state && stored) {
        next.state.feedAnchorByView = mergeByUpdatedAt(
          next.state.feedAnchorByView ?? {},
          stored,
          droppedAnchors,
        );
        text = JSON.stringify(next);
      }
    } catch {
      // Unreadable stored state: this tab's value replaces it.
    }
    droppedAnchors.clear();
    localStorage.setItem(name, text);
  },
  removeItem: (name: string) => localStorage.removeItem(name),
};

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      feedAnchorByView: {},
      sidebarCollapsed: false,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,

      // A feed anchor is written on a debounce from the scroll handler, so the
      // store is reached at most every 200 ms rather than every frame.
      recordFeedAnchor: (view, anchor) =>
        set((state) => {
          const current = state.feedAnchorByView[view];
          if (anchor === null) {
            if (!current) return state;
            const next = { ...state.feedAnchorByView };
            delete next[view];
            droppedAnchors.set(view, Date.now());
            return { feedAnchorByView: next };
          }
          if (
            current &&
            current.key === anchor.key &&
            current.offset === anchor.offset &&
            current.top === anchor.top
          ) {
            return state;
          }
          return {
            feedAnchorByView: {
              ...state.feedAnchorByView,
              [view]: { ...anchor, updatedAt: Date.now() },
            },
          };
        }),
      feedAnchorFor: (view) => get().feedAnchorByView[view] ?? null,

      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
    }),
    {
      name: NAVIGATION_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => mergingStorage),
      partialize: (state) => ({
        feedAnchorByView: state.feedAnchorByView,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
);

// Another tab wrote: its newer anchors are taken in. Stops once both tabs
// hold the same anchors, since an unchanged merge writes nothing.
onOtherTabWrite(NAVIGATION_STORAGE_KEY, (value) => {
  const other = storedAnchors(value);
  if (!other) return;
  const current = useNavigationStore.getState().feedAnchorByView;
  const merged = mergeByUpdatedAt(current, other, droppedAnchors);
  if (!sameAnchors(merged, current)) useNavigationStore.setState({ feedAnchorByView: merged });
});
