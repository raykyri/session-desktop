// Intra-page view coordinates that do not belong in the URL (07 §4.3, §8):
// the per-tree node history stack, the sidebar's width and collapsed state,
// and the per-node scroll offsets and "show earlier" expansions that make
// returning to a document land where the reader left it.
//
// Cross-page history is browser history now, so the desktop's
// `ResearchWorkspaceHistory` reducer is retired (ADR-7). What stays is the
// per-document history, because it moves between nodes inside one route.

import {
  EMPTY_RESEARCH_HISTORY,
  RESEARCH_SCROLL_POSITION_TTL_MS,
  canGoBack,
  canGoForward,
  initResearchHistory,
  pushResearchHistory,
  researchHistoryBack,
  researchHistoryForward,
  type ResearchHistory,
} from "@session/shared";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const NAVIGATION_STORAGE_KEY = "session.navigation.v2";

export type ResearchVisibilityFilter = "active" | "archived" | "all";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 268;

export interface SavedScrollOffset {
  top: number;
  updatedAt: number;
}

export interface NavigationState {
  /** Per-tree node history, the intra-document analogue of browser history. */
  historyByTree: Record<string, ResearchHistory>;
  scrollByNode: Record<string, SavedScrollOffset>;
  expandedByNode: Record<string, boolean>;
  visibilityFilter: ResearchVisibilityFilter;
  sidebarCollapsed: boolean;
  sidebarWidth: number;

  historyFor: (treeId: string) => ResearchHistory;
  visitNode: (treeId: string, nodeId: string) => void;
  goBack: (treeId: string) => string | null;
  goForward: (treeId: string) => string | null;
  canGoBack: (treeId: string) => boolean;
  canGoForward: (treeId: string) => boolean;
  clearHistory: (treeId: string) => void;

  recordScroll: (nodeId: string, top: number, now?: number) => void;
  restoreScroll: (nodeId: string, now?: number) => number | null;
  setExpanded: (nodeId: string, expanded: boolean) => void;

  setVisibilityFilter: (filter: ResearchVisibilityFilter) => void;
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
      historyByTree: {},
      scrollByNode: {},
      expandedByNode: {},
      visibilityFilter: "active",
      sidebarCollapsed: false,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,

      historyFor: (treeId) => get().historyByTree[treeId] ?? EMPTY_RESEARCH_HISTORY,
      visitNode: (treeId, nodeId) =>
        set((state) => {
          const current = state.historyByTree[treeId];
          const next = current ? pushResearchHistory(current, nodeId) : initResearchHistory(nodeId);
          if (next === current) return state;
          return { historyByTree: { ...state.historyByTree, [treeId]: next } };
        }),
      goBack: (treeId) => {
        const step = researchHistoryBack(get().historyFor(treeId));
        if (!step) return null;
        set((state) => ({ historyByTree: { ...state.historyByTree, [treeId]: step.history } }));
        return step.nodeId;
      },
      goForward: (treeId) => {
        const step = researchHistoryForward(get().historyFor(treeId));
        if (!step) return null;
        set((state) => ({ historyByTree: { ...state.historyByTree, [treeId]: step.history } }));
        return step.nodeId;
      },
      canGoBack: (treeId) => canGoBack(get().historyFor(treeId)),
      canGoForward: (treeId) => canGoForward(get().historyFor(treeId)),
      clearHistory: (treeId) =>
        set((state) => {
          if (!(treeId in state.historyByTree)) return state;
          const next = { ...state.historyByTree };
          delete next[treeId];
          return { historyByTree: next };
        }),

      recordScroll: (nodeId, top, now = Date.now()) =>
        set((state) => ({
          scrollByNode: { ...state.scrollByNode, [nodeId]: { top, updatedAt: now } },
        })),
      // Offsets expire: a position captured against content that has since
      // streamed further lands in the wrong place, and after a quarter hour the
      // reader is starting over anyway.
      restoreScroll: (nodeId, now = Date.now()) => {
        const saved = get().scrollByNode[nodeId];
        if (!saved) return null;
        if (now - saved.updatedAt > RESEARCH_SCROLL_POSITION_TTL_MS) return null;
        return saved.top;
      },
      setExpanded: (nodeId, expanded) =>
        set((state) => ({ expandedByNode: { ...state.expandedByNode, [nodeId]: expanded } })),

      setVisibilityFilter: (visibilityFilter) => set({ visibilityFilter }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
    }),
    {
      name: NAVIGATION_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        scrollByNode: state.scrollByNode,
        expandedByNode: state.expandedByNode,
        visibilityFilter: state.visibilityFilter,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
);
