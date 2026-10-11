import { useCallback, useEffect, useMemo, useRef } from "react";
import { ACTIVE_RESEARCH_TREE_KEY, type ResearchData } from "./useResearchData";
import { RESEARCH_WORKSPACE_SCOPE_KEY, type useResearchNavigationState } from "./useResearchNavigationState";
import {
  getResearchTree,
  listRecentActivity,
  listRecentActivityForTrees,
  listResearchActivity,
  listResearchTrees,
  markResearchTreeViewed,
} from "../lib/api";
import {
  activityCursorIsBefore,
  mergeRecentActivityItems,
  reconcileRecentActivityHead,
  recentActivityCursor as recentActivityItemCursor,
  upsertRecentActivityResearchNode,
  type RecentActivityPage,
} from "../lib/activity";
import { IS_MAC } from "../lib/appHelpers";
import { patchResearchDetailNode, upsertResearchActivity } from "../lib/researchEvents";
import {
  canGoResearchBack,
  canGoResearchForward,
  currentResearchVisit,
  pruneResearchVisits,
  pushResearchVisit,
  replaceResearchVisit,
  researchVisitAction,
  researchVisitBack,
  researchVisitFor,
  researchVisitForward,
  researchVisitsAfterRemoval,
  seedResearchVisits,
  type ResearchVisit,
} from "../lib/researchHistory";
import {
  pruneResearchNavigation,
  researchNavigationStore,
  saveResearchNavigation,
} from "../lib/researchNavigation";
import { resolveResearchScope, treeForResearchScope, type ResearchWorkspaceScope } from "../lib/researchScope";
import { requestResearchNodeOpen } from "../lib/researchShortcuts";
import {
  reconcileResearchActivity,
  reconcileResearchTreeDetail,
  reconcileResearchTreeSummaries,
} from "../lib/researchSnapshots";
import { partitionResearchTrees } from "../lib/researchTreeSummaries";
import { groupsForScope } from "../lib/workspaceScope";
import type {
  GroupInfo,
  RecentResearchQuery,
  ResearchHighlightFeedItem,
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "../types";

type ResearchViewedAckOptions = {
  /** A real exposure edge (selection, focus, composer close) should check the
   * backend even when the current sidebar snapshot carries no attention bit. */
  force?: boolean;
  /** The accepted navigation snapshot already proved this tree has attention. */
  knownUnseen?: boolean;
};

function researchThreadIsVisible(treeId: string, activeTreeId: string | null): boolean {
  return (
    activeTreeId === treeId &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

/** The startup snapshot's research part. */
interface ResearchStartupSnapshot {
  trees: ResearchTreeSummary[];
  activity: ResearchNode[];
  recentActivity: RecentActivityPage;
  groups: GroupInfo[];
}

/**
 * What the research surface shows and how it moves: the open thread (and its
 * fetched detail), Home and the feed, back/forward over the visit history,
 * navigation refreshes, and viewed acknowledgments that clear attention
 * badges.
 */
export function useResearchNavigation(
  data: ResearchData,
  navigationState: ReturnType<typeof useResearchNavigationState>,
  researchScope: ResearchWorkspaceScope,
) {
  const {
    setResearchTrees,
    researchTreesRef,
    setArchivedResearchTrees,
    archivedResearchTreesRef,
    setResearchActivity,
    setRecentActivityItems,
    recentActivityItemsRef,
    activeResearchTreeId,
    setActiveResearchTreeId,
    activeResearchTreeIdRef,
    setActiveResearchDetail,
    setActiveResearchDetailError,
    researchDetailRequestSeqRef,
    researchNavRefreshSeqRef,
    researchNavRefreshInFlightRef,
    recentActivityRootRequestSeqRef,
    recentActivityHeadRequestSeqRef,
    clearActiveResearchTree,
    setActiveResearchTree,
    clearResearchUnseen,
  } = data;
  const {
    feedOpen,
    setFeedOpen,
    researchVisits,
    researchVisitsRef,
    updateResearchVisits,
    changeResearchWorkspaceScope,
  } = navigationState;
  const researchScopeRef = useRef(researchScope);
  researchScopeRef.current = researchScope;
  // What the research stage shows beside the feed column: the open thread,
  // or (with no thread open, or the feed brought forward) the feed alone.
  const researchStageView =
    feedOpen || !activeResearchTreeId ? ("feed" as const) : ("thread" as const);
  const researchStageViewRef = useRef(researchStageView);
  researchStageViewRef.current = researchStageView;
  const researchViewAckInFlightRef = useRef(new Set<string>());
  const researchViewAckPendingRef = useRef(new Set<string>());
  const markVisibleResearchTreeViewedRef = useRef<
    (treeId: string, options?: ResearchViewedAckOptions) => Promise<void>
  >(async () => undefined);

  // Back/forward history (researchHistory.ts): every change of what the
  // research surface shows — a thread's selected message, or Home with no
  // thread open — is recorded here, so back and forward replay switches
  // between questions within a thread and across threads in order.
  const recordResearchVisit = useCallback(
    (visit: ResearchVisit) => updateResearchVisits((current) => pushResearchVisit(current, visit)),
    [updateResearchVisits],
  );
  // Removes visits to removed trees. The visit on screen stays: the caller
  // is still showing it and navigates away itself.
  const pruneResearchTreeVisits = useCallback(
    (keepTree: (treeId: string) => boolean) =>
      updateResearchVisits((current) =>
        pruneResearchVisits(current, (visit) => visit.kind === "home" || keepTree(visit.treeId), {
          keepCurrent: true,
        }),
      ),
    [updateResearchVisits],
  );
  const refreshResearchNavigation = useCallback(async (
    options: { resetLoadedTail?: boolean } = {},
  ): Promise<ResearchTreeSummary[] | null> => {
    // Refreshes can overlap, and the list calls below resolve independently.
    // Apply only the latest request so an older snapshot cannot restore a
    // running badge, unseen flag, or removed tree.
    const requestSeq = researchNavRefreshSeqRef.current + 1;
    researchNavRefreshSeqRef.current = requestSeq;
    const activityRequestSeq = recentActivityHeadRequestSeqRef.current + 1;
    recentActivityHeadRequestSeqRef.current = activityRequestSeq;
    recentActivityRootRequestSeqRef.current += 1;
    researchNavRefreshInFlightRef.current += 1;
    try {
      const [trees, activity, recentActivity] = await Promise.all([
        listResearchTrees(true),
        listResearchActivity(),
        listRecentActivity(),
      ]);
      if (researchNavRefreshSeqRef.current !== requestSeq) {
        return null;
      }
      const partitioned = partitionResearchTrees(trees);
      setResearchTrees((current) =>
        reconcileResearchTreeSummaries(current, partitioned.active),
      );
      setArchivedResearchTrees((current) =>
        reconcileResearchTreeSummaries(current, partitioned.archived),
      );
      setResearchActivity((current) => reconcileResearchActivity(current, activity));
      if (recentActivityHeadRequestSeqRef.current === activityRequestSeq) {
        const headCursor = recentActivity.nextCursor ?? null;
        // Archived trees are omitted from activity queries. Restoring a tree
        // only refetches the head, so drop the tail; the feed loads the
        // roots of listed cards that are no longer loaded.
        const preserveLoadedTail =
          !options.resetLoadedTail &&
          headCursor !== null &&
          recentActivityItemsRef.current.some((item) =>
            activityCursorIsBefore(recentActivityItemCursor(item), headCursor),
          );
        setRecentActivityItems((current) => {
          const next = reconcileRecentActivityHead(
            current,
            recentActivity.items,
            preserveLoadedTail ? headCursor : null,
          );
          recentActivityItemsRef.current = next;
          return next;
        });
      }
      // A failed root launch can remove the selected tree. Clear the selection
      // so the thread page does not keep loading a tree that no longer exists.
      const activeTreeId = activeResearchTreeIdRef.current;
      if (activeTreeId && !trees.some((tree) => tree.id === activeTreeId)) {
        recordResearchVisit({ kind: "home" });
        clearActiveResearchTree();
      }
      // Navigation restoration state for trees that no longer exist would
      // otherwise accumulate in localStorage forever.
      pruneResearchNavigation(trees.map((tree) => tree.id));
      // Prune deleted trees from history.
      const knownTreeIds = new Set(trees.map((tree) => tree.id));
      pruneResearchTreeVisits((id) => knownTreeIds.has(id));
      return trees;
    } finally {
      researchNavRefreshInFlightRef.current -= 1;
    }
  }, [
    activeResearchTreeIdRef,
    clearActiveResearchTree,
    pruneResearchTreeVisits,
    recentActivityHeadRequestSeqRef,
    recentActivityItemsRef,
    recentActivityRootRequestSeqRef,
    recordResearchVisit,
    researchNavRefreshInFlightRef,
    researchNavRefreshSeqRef,
    setArchivedResearchTrees,
    setRecentActivityItems,
    setResearchActivity,
    setResearchTrees,
  ]);

  const markVisibleResearchTreeViewed = useCallback(
    async (treeId: string, options: ResearchViewedAckOptions = {}) => {
      if (!researchThreadIsVisible(treeId, activeResearchTreeIdRef.current)) {
        return;
      }
      const hadUnseen =
        options.knownUnseen === true ||
        [...researchTreesRef.current, ...archivedResearchTreesRef.current].some(
          (tree) => tree.id === treeId && (tree.hasUnseenUpdate || tree.hasUnseenFailure),
        );
      if (!options.force && !hadUnseen) {
        return;
      }
      if (researchViewAckInFlightRef.current.has(treeId)) {
        // If a navigation result found unseen activity during an acknowledgment,
        // schedule another check. Focus and visibility duplicates reuse the
        // current request.
        if (options.knownUnseen) {
          researchViewAckPendingRef.current.add(treeId);
        }
        return;
      }
      researchViewAckInFlightRef.current.add(treeId);
      try {
        await markResearchTreeViewed(treeId);
        // A refresh may contain a snapshot from before the acknowledgment even
        // if its unseen flag has not reached React state. Check for it after the
        // acknowledgment completes.
        const staleNavigationMayStillLand = researchNavRefreshInFlightRef.current > 0;
        clearResearchUnseen(treeId);
        // Refetch if a badge was set or an older navigation request is pending.
        // The request sequence prevents a pre-acknowledgment snapshot from
        // restoring cleared badges.
        if (hadUnseen || staleNavigationMayStillLand) {
          void refreshResearchNavigation().catch(() => undefined);
        }
      } finally {
        researchViewAckInFlightRef.current.delete(treeId);
        if (researchViewAckPendingRef.current.delete(treeId)) {
          queueMicrotask(() => {
            void markVisibleResearchTreeViewedRef.current(treeId, {
              knownUnseen: true,
            }).catch(() => undefined);
          });
        }
      }
    },
    [
      activeResearchTreeIdRef,
      archivedResearchTreesRef,
      clearResearchUnseen,
      refreshResearchNavigation,
      researchNavRefreshInFlightRef,
      researchTreesRef,
    ],
  );
  markVisibleResearchTreeViewedRef.current = markVisibleResearchTreeViewed;
  useEffect(() => {
    const markCurrent = () => {
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        void markVisibleResearchTreeViewed(treeId, { force: true }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", markCurrent);
    document.addEventListener("visibilitychange", markCurrent);
    return () => {
      window.removeEventListener("focus", markCurrent);
      document.removeEventListener("visibilitychange", markCurrent);
    };
  }, [activeResearchTreeIdRef, markVisibleResearchTreeViewed]);

  const selectResearchTree = useCallback(async (treeId: string) => {
    const requestSeq = researchDetailRequestSeqRef.current + 1;
    researchDetailRequestSeqRef.current = requestSeq;
    setFeedOpen(false);
    setActiveResearchTree(treeId);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    try {
      const detail = await getResearchTree(treeId);
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetail((current) =>
          reconcileResearchTreeDetail(current, detail),
        );
        // Selection can arrive from outside the scoped sidebar (archive
        // restore, a remembered tree on mode switch). Follow it with the
        // workspace scope, or the thread page would show a tree the sidebar
        // doesn't list — with nothing highlighted anywhere.
        if (researchScopeRef.current !== detail.tree.workspaceId) {
          changeResearchWorkspaceScope(detail.tree.workspaceId);
        }
        void markVisibleResearchTreeViewed(treeId, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      // Surfaced inside the thread page (with a working Retry) rather than as a
      // global banner: without detail the thread page has no node to load, so
      // the error and its recovery belong where the user is looking.
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [
    activeResearchTreeIdRef,
    changeResearchWorkspaceScope,
    markVisibleResearchTreeViewed,
    researchDetailRequestSeqRef,
    setActiveResearchDetail,
    setActiveResearchDetailError,
    setActiveResearchTree,
    setFeedOpen,
  ]);
  /** Whether `treeId`'s thread page is mounted and on screen. */
  const researchThreadShown = useCallback(
    (treeId: string) =>
      activeResearchTreeIdRef.current === treeId && researchStageViewRef.current === "thread",
    [activeResearchTreeIdRef],
  );
  // Opens a thread at the message it restores (its last selection). The
  // visit names no message until the thread page reports the one it
  // restored. The thread already on screen is left as it is.
  const navigateToResearchThread = useCallback(
    (treeId: string) => {
      if (researchThreadShown(treeId)) {
        return;
      }
      recordResearchVisit({ kind: "node", treeId, nodeId: null });
      void selectResearchTree(treeId);
    },
    [recordResearchVisit, researchThreadShown, selectResearchTree],
  );
  // Opens a node of a tree: its level, and the levels before it, open as
  // column pairs, with the node selected. The store covers a thread page
  // that mounts for this tree. A thread page already showing the tree gets
  // the request instead, selects the node in place (no refetch, so its
  // columns do not blink) and records the visit itself; when its loaded
  // tree does not have the node yet, the tree is fetched again.
  const openResearchNode = useCallback(
    (treeId: string, nodeId: string) => {
      const navigationStore = researchNavigationStore();
      const navigation = navigationStore[treeId] ?? { scrollByNode: {} };
      navigation.selectedNodeId = nodeId;
      navigationStore[treeId] = navigation;
      saveResearchNavigation();
      if (researchThreadShown(treeId) && requestResearchNodeOpen(treeId, nodeId)) {
        return;
      }
      recordResearchVisit({ kind: "node", treeId, nodeId });
      void selectResearchTree(treeId);
    },
    [recordResearchVisit, researchThreadShown, selectResearchTree],
  );
  const openRecentResearchQuery = useCallback(
    (query: RecentResearchQuery) => openResearchNode(query.treeId, query.nodeId),
    [openResearchNode],
  );
  const openResearchHighlight = useCallback(
    (item: ResearchHighlightFeedItem) => {
      // Record the highlight before navigation so visit restoration selects it
      // instead of applying the saved scroll offset.
      const navigationStore = researchNavigationStore();
      const navigation = (navigationStore[item.treeId] ??= { scrollByNode: {} });
      navigation.focusHighlight = { nodeId: item.nodeId, highlightId: item.highlightId };
      openResearchNode(item.treeId, item.nodeId);
    },
    [openResearchNode],
  );
  const handleResearchRecapApplied = useCallback((node: ResearchNode) => {
    setActiveResearchDetail((current) => patchResearchDetailNode(current, node));
    setResearchActivity((current) => upsertResearchActivity(current, node));
    setRecentActivityItems((current) => {
      const next = upsertRecentActivityResearchNode(current, node);
      recentActivityItemsRef.current = next;
      return next;
    });
  }, [recentActivityItemsRef, setActiveResearchDetail, setRecentActivityItems, setResearchActivity]);
  /** Loads the feed roots of trees listed in Home or Bookmarks whose root is
   * not loaded. A response that an event or refresh made stale is fetched
   * again. */
  const loadActivityForTrees = useCallback(async (treeIds: string[]) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestSeq = recentActivityRootRequestSeqRef.current;
      const roots = await listRecentActivityForTrees(treeIds);
      if (recentActivityRootRequestSeqRef.current !== requestSeq) continue;
      setRecentActivityItems((current) => {
        const next = mergeRecentActivityItems(current, roots);
        recentActivityItemsRef.current = next;
        return next;
      });
      return;
    }
  }, [recentActivityItemsRef, recentActivityRootRequestSeqRef, setRecentActivityItems]);
  const retryActiveResearchDetail = useCallback(() => {
    const treeId = activeResearchTreeIdRef.current;
    if (treeId) {
      void selectResearchTree(treeId);
    }
  }, [activeResearchTreeIdRef, selectResearchTree]);
  const focusResearchHome = useCallback(() => {
    recordResearchVisit({ kind: "home" });
    // Invalidate a tree request that may still be landing while Home is
    // selected; otherwise its detail can repaint behind the launcher.
    researchDetailRequestSeqRef.current += 1;
    setFeedOpen(true);
    clearActiveResearchTree();
  }, [clearActiveResearchTree, recordResearchVisit, researchDetailRequestSeqRef, setFeedOpen]);
  // Brings the feed page forward. The feed is a peer page of a research
  // thread, not an overlay on one: opening it drops the tree selection the
  // way Home does, so the sidebar never shows a selected row behind the tab
  // that is actually forward.
  const showFeed = useCallback(() => {
    researchDetailRequestSeqRef.current += 1;
    clearActiveResearchTree();
    setFeedOpen(true);
  }, [clearActiveResearchTree, researchDetailRequestSeqRef, setFeedOpen]);

  // Shows a visit that back or forward moved to, without recording it.
  const applyResearchVisit = useCallback(
    (visit: ResearchVisit) => {
      const action = researchVisitAction(
        visit,
        activeResearchTreeIdRef.current,
        researchStageViewRef.current === "thread",
      );
      if (visit.kind === "home" || action === "home") {
        showFeed();
        return;
      }
      if (visit.nodeId) {
        const navigationStore = researchNavigationStore();
        const navigation = (navigationStore[visit.treeId] ??= { scrollByNode: {} });
        navigation.selectedNodeId = visit.nodeId;
        saveResearchNavigation();
      }
      if (action === "in-place") {
        if (!visit.nodeId || requestResearchNodeOpen(visit.treeId, visit.nodeId, { record: false })) {
          return;
        }
      }
      void selectResearchTree(visit.treeId);
    },
    [activeResearchTreeIdRef, selectResearchTree, showFeed],
  );
  const goResearchBack = useCallback(() => {
    const step = researchVisitBack(researchVisitsRef.current);
    if (!step) {
      return;
    }
    updateResearchVisits(() => step.history);
    applyResearchVisit(step.visit);
  }, [applyResearchVisit, researchVisitsRef, updateResearchVisits]);
  const goResearchForward = useCallback(() => {
    const step = researchVisitForward(researchVisitsRef.current);
    if (!step) {
      return;
    }
    updateResearchVisits(() => step.history);
    applyResearchVisit(step.visit);
  }, [applyResearchVisit, researchVisitsRef, updateResearchVisits]);
  // User navigation in the thread page pushes a visit; an automatic selection
  // (the message restored on opening)
  // replaces the visit on screen when that is a visit to this thread.
  const reportResearchNavigation = useCallback(
    (treeId: string, nodeId: string, mode: "push" | "replace") => {
      const visit: ResearchVisit = { kind: "node", treeId, nodeId };
      updateResearchVisits((current) => {
        const shown = currentResearchVisit(current);
        return mode === "replace" && shown?.kind === "node" && shown.treeId === treeId
          ? replaceResearchVisit(current, visit)
          : pushResearchVisit(current, visit);
      });
    },
    [updateResearchVisits],
  );
  // Removed messages: their visits go; `selection` is the message the
  // thread page moved to.
  const pruneResearchNodeVisits = useCallback(
    (treeId: string, keepNode: (nodeId: string) => boolean, selection: string | null) => {
      const keep = (visit: ResearchVisit) =>
        visit.kind === "home" || visit.treeId !== treeId || visit.nodeId === null || keepNode(visit.nodeId);
      updateResearchVisits((current) =>
        selection
          ? researchVisitsAfterRemoval(current, keep, { kind: "node", treeId, nodeId: selection })
          : pruneResearchVisits(current, keep),
      );
    },
    [updateResearchVisits],
  );
  // Back and forward for the content column's header (the open thread's,
  // or the empty column's with no thread open).
  const researchHistoryNav = useMemo(
    () => ({
      canGoBack: canGoResearchBack(researchVisits),
      canGoForward: canGoResearchForward(researchVisits),
      backTitle: `Back (${IS_MAC ? "⌘[" : "Ctrl+["})`,
      forwardTitle: `Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`,
      onBack: goResearchBack,
      onForward: goResearchForward,
    }),
    [goResearchBack, goResearchForward, researchVisits],
  );

  // Focuses a tree that a composer just created: the new tree selected with
  // its detail already in hand, and the sidebar scoped to its folder (a first
  // item creates its private default folder — follow it so the single-folder
  // sidebar immediately lists the new tree).
  const adoptCreatedResearchTree = useCallback(
    (detail: ResearchTreeDetail) => {
      researchDetailRequestSeqRef.current += 1;
      // Clear feedOpen so the new thread is visible after closing a
      // conversation or opening a draft.
      setFeedOpen(false);
      // A new question is a visit like opening one: Back returns to what was
      // open before it.
      recordResearchVisit({ kind: "node", treeId: detail.tree.id, nodeId: null });
      setActiveResearchTree(detail.tree.id);
      setActiveResearchDetail((current) =>
        reconcileResearchTreeDetail(current, detail),
      );
      setActiveResearchDetailError(null);
      if (researchScopeRef.current !== detail.tree.workspaceId) {
        changeResearchWorkspaceScope(detail.tree.workspaceId);
      }
    },
    [
      changeResearchWorkspaceScope,
      recordResearchVisit,
      researchDetailRequestSeqRef,
      setActiveResearchDetail,
      setActiveResearchDetailError,
      setActiveResearchTree,
      setFeedOpen,
    ],
  );

  /** Applies the startup snapshot's research lists. The returned function
   * restores the tree open at the last quit, when it is still in the restored
   * workspace scope, and seeds back/forward with it (or Home). */
  const hydrateResearch = useCallback(
    ({ trees, activity, recentActivity, groups }: ResearchStartupSnapshot) => {
      const partitionedResearchTrees = partitionResearchTrees(trees);
      setResearchTrees(partitionedResearchTrees.active);
      setArchivedResearchTrees(partitionedResearchTrees.archived);
      setResearchActivity(activity);
      recentActivityItemsRef.current = recentActivity.items;
      setRecentActivityItems(recentActivity.items);
      const savedResearchTreeId = localStorage.getItem(ACTIVE_RESEARCH_TREE_KEY);
      const restoredResearchScope = resolveResearchScope(
        localStorage.getItem(RESEARCH_WORKSPACE_SCOPE_KEY),
        groupsForScope(groups, "research"),
      );
      const allResearchTrees = [
        ...partitionedResearchTrees.active,
        ...partitionedResearchTrees.archived,
      ];
      const researchTreeToRestore = savedResearchTreeId
        ? treeForResearchScope(allResearchTrees, restoredResearchScope, savedResearchTreeId)
        : null;
      return async (isCancelled: () => boolean) => {
        if (isCancelled()) return;
        if (!researchTreeToRestore) {
          if (savedResearchTreeId) {
            localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
          }
          if (!isCancelled()) {
            // Back/forward starts at Home.
            updateResearchVisits((current) => seedResearchVisits(current, researchVisitFor(null, null)));
            activeResearchTreeIdRef.current = null;
            setActiveResearchTreeId(null);
            setActiveResearchDetail(null);
            setActiveResearchDetailError(null);
          }
          return;
        }
        // Back/forward starts at the restored thread, so the first switch to
        // another question can go back to it. The thread page names the
        // message once it restores one.
        const seedRestoredVisit = () =>
          updateResearchVisits((current) =>
            seedResearchVisits(current, researchVisitFor(researchTreeToRestore.id, null)),
          );
        try {
          const detail = await getResearchTree(researchTreeToRestore.id);
          if (!isCancelled()) {
            seedRestoredVisit();
            setActiveResearchTreeId(researchTreeToRestore.id);
            localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
            setActiveResearchDetail((current) =>
              reconcileResearchTreeDetail(current, detail),
            );
            if (researchThreadIsVisible(researchTreeToRestore.id, researchTreeToRestore.id)) {
              void markResearchTreeViewed(researchTreeToRestore.id)
                .then(() => {
                  if (isCancelled()) return;
                  setResearchTrees((current) =>
                    current.map((tree) =>
                      tree.id === researchTreeToRestore.id
                        ? { ...tree, hasUnseenUpdate: false, hasUnseenFailure: false }
                        : tree,
                    ),
                  );
                })
                .catch(() => undefined);
            }
          }
        } catch (err) {
          // Mirror selectResearchTree's failure path: keep the selection and
          // surface the error inside the thread page (which has a working
          // Retry). A later navigation refresh clears the selection if the
          // tree is truly gone.
          if (!isCancelled()) {
            seedRestoredVisit();
            setActiveResearchTreeId(researchTreeToRestore.id);
            localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
            setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
          }
        }
      };
    },
    [
      activeResearchTreeIdRef,
      recentActivityItemsRef,
      setActiveResearchDetail,
      setActiveResearchDetailError,
      setActiveResearchTreeId,
      setArchivedResearchTrees,
      setRecentActivityItems,
      setResearchActivity,
      setResearchTrees,
      updateResearchVisits,
    ],
  );

  return {
    researchStageView,
    researchStageViewRef,
    markVisibleResearchTreeViewedRef,
    recordResearchVisit,
    pruneResearchTreeVisits,
    refreshResearchNavigation,
    markVisibleResearchTreeViewed,
    selectResearchTree,
    navigateToResearchThread,
    openResearchNode,
    openRecentResearchQuery,
    openResearchHighlight,
    handleResearchRecapApplied,
    loadActivityForTrees,
    retryActiveResearchDetail,
    focusResearchHome,
    goResearchBack,
    goResearchForward,
    reportResearchNavigation,
    pruneResearchNodeVisits,
    researchHistoryNav,
    adoptCreatedResearchTree,
    hydrateResearch,
  };
}

export type ResearchNavigation = ReturnType<typeof useResearchNavigation>;
