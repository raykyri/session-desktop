// Page chrome state that does not belong in the URL (07 §4.3, §8): the
// sidebar's width and collapsed state, and the feeds' scroll
// anchors.
//
// History is browser history (ADR-7): a thread's selection is its `?sel=`
// search parameter, and what a thread keeps per tree across visits (scroll
// offsets, expansions, the unsent branch) is in
// `features/thread/persistence.ts`.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

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
          return { feedAnchorByView: { ...state.feedAnchorByView, [view]: anchor } };
        }),
      feedAnchorFor: (view) => get().feedAnchorByView[view] ?? null,

      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
    }),
    {
      name: NAVIGATION_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        feedAnchorByView: state.feedAnchorByView,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
);
