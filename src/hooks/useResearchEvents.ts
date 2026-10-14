import { useCallback, useEffect, useRef } from "react";
import type { ResearchData } from "./useResearchData";
import type { ResearchNavigation } from "./useResearchNavigation";
import { getResearchTree } from "../lib/api";
import { upsertRecentActivityResearchNode } from "@session/shared/lib/activity";
import {
  addResearchNodeHighlight,
  parseResearchEvent,
  patchResearchDetailHighlightCreated,
  patchResearchDetailHighlightsRemoved,
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForNode,
  patchResearchSummaryForRemovedNodes,
  patchResearchSummaryTree,
  removeResearchDetailNodes,
  removeResearchNodeHighlights,
  removeResearchNodes,
  researchSummaryFromDetail,
  upsertResearchActivity,
  type ParsedResearchEvent,
} from "@session/shared/lib/researchEvents";
import { pruneResearchNavigation, pruneResearchNavigationNodes } from "../lib/researchNavigation";
import { nodeRun, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { reconcileResearchTreeDetail } from "@session/shared/research/snapshots";
import {
  patchResearchTreeSummaries,
  removeResearchTreeSummary,
  replaceResearchActivityForTree,
  upsertResearchTreeSummary,
} from "@session/shared/lib/researchTreeSummaries";
import type { ResearchNode, ResearchTreeSummary, SessionEvent } from "../types";

interface ResearchEventTargets {
  /** Reloads the drafts list when `workspaceId` is the scoped workspace. */
  refreshResearchDrafts: (workspaceId: string) => unknown;
  refreshResearchFolders: () => unknown;
  /** Reloads the Trash. Stable: the handler captures it once. */
  refreshResearchTrash: () => unknown;
  /** Marks the Highlights feed stale. */
  invalidateResearchHighlights: () => void;
}

/**
 * Applies `research.*` session events to the research data: summaries,
 * activity, the feed's recent activity and the open tree's detail are patched
 * from the event payload, and per-tree or full refetches recover state an
 * event cannot carry. Returns the event handler, which the session event
 * subscription captures once.
 */
export function useResearchEvents(
  data: ResearchData,
  navigation: ResearchNavigation,
  {
    refreshResearchDrafts,
    refreshResearchFolders,
    refreshResearchTrash,
    invalidateResearchHighlights,
  }: ResearchEventTargets,
) {
  const {
    setResearchTrees,
    researchTreesRef,
    setArchivedResearchTrees,
    archivedResearchTreesRef,
    setResearchActivity,
    setRecentActivityItems,
    recentActivityItemsRef,
    setRecapPendingNodeIds,
    activeResearchTreeIdRef,
    setActiveResearchDetail,
    activeResearchDetailRef,
    setActiveResearchDetailError,
    researchNodeEventCacheRef,
    researchDetailRequestSeqRef,
    researchNavRefreshSeqRef,
    researchNavRefreshInFlightRef,
    recentActivityRootRequestSeqRef,
  } = data;
  const {
    refreshResearchNavigation,
    markVisibleResearchTreeViewed,
    markVisibleResearchTreeViewedRef,
    pruneResearchTreeVisits,
    focusResearchHome,
  } = navigation;
  // Full navigation + active-detail recovery is deliberately reserved for an
  // unknown/malformed event or a rare collection-order transition. Ordinary
  // research events carry enough state to patch locally below.
  const researchRefreshTimerRef = useRef<number | null>(null);
  const researchRefreshResetTailRef = useRef(false);
  const researchNavigationRecoveryTimerRef = useRef<number | null>(null);
  const researchTreeRecoveryTimersRef = useRef(new Map<string, number>());
  const researchTreeEventVersionRef = useRef(new Map<string, number>());
  const removedResearchTreeIdsRef = useRef(new Set<string>());
  useEffect(
    () => () => {
      if (researchRefreshTimerRef.current !== null) {
        window.clearTimeout(researchRefreshTimerRef.current);
      }
      if (researchNavigationRecoveryTimerRef.current !== null) {
        window.clearTimeout(researchNavigationRecoveryTimerRef.current);
      }
      for (const timer of researchTreeRecoveryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      researchTreeRecoveryTimersRef.current.clear();
    },
    [],
  );
  const scheduleResearchRefresh = useCallback((options: { resetLoadedTail?: boolean } = {}) => {
    // Coalesce tail reset requests across callers during the debounce window.
    if (options.resetLoadedTail) {
      researchRefreshResetTailRef.current = true;
    }
    if (researchRefreshTimerRef.current !== null) {
      return;
    }
    researchRefreshTimerRef.current = window.setTimeout(() => {
      researchRefreshTimerRef.current = null;
      const resetLoadedTail = researchRefreshResetTailRef.current;
      researchRefreshResetTailRef.current = false;
      void refreshResearchNavigation({ resetLoadedTail })
        .then((trees) => {
          const treeId = activeResearchTreeIdRef.current;
          const tree = treeId ? trees?.find((candidate) => candidate.id === treeId) : null;
          if (treeId && tree && (tree.hasUnseenUpdate || tree.hasUnseenFailure)) {
            void markVisibleResearchTreeViewed(treeId, { knownUnseen: true }).catch(
              () => undefined,
            );
          }
        })
        .catch(() => undefined);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        const requestSeq = researchDetailRequestSeqRef.current + 1;
        researchDetailRequestSeqRef.current = requestSeq;
        void getResearchTree(treeId)
          .then((detail) => {
            if (
              researchDetailRequestSeqRef.current === requestSeq &&
              activeResearchTreeIdRef.current === treeId
            ) {
              setActiveResearchDetail((current) =>
                reconcileResearchTreeDetail(current, detail),
              );
              setActiveResearchDetailError(null);
            }
          })
          .catch(() => undefined);
      }
    }, 250);
  }, [markVisibleResearchTreeViewed, refreshResearchNavigation]);
  const scheduleResearchNavigationRecovery = useCallback(() => {
    if (researchNavigationRecoveryTimerRef.current !== null) {
      window.clearTimeout(researchNavigationRecoveryTimerRef.current);
    }
    researchNavigationRecoveryTimerRef.current = window.setTimeout(() => {
      researchNavigationRecoveryTimerRef.current = null;
      void refreshResearchNavigation()
        .then((trees) => {
          const treeId = activeResearchTreeIdRef.current;
          const tree = treeId ? trees?.find((candidate) => candidate.id === treeId) : null;
          if (treeId && tree && (tree.hasUnseenUpdate || tree.hasUnseenFailure)) {
            void markVisibleResearchTreeViewedRef.current(treeId, {
              knownUnseen: true,
            }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 300);
  }, [refreshResearchNavigation]);
  const scheduleResearchTreeRecovery = useCallback(
    (treeId: string) => {
      if (removedResearchTreeIdsRef.current.has(treeId)) {
        return;
      }
      const existingTimer = researchTreeRecoveryTimersRef.current.get(treeId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      const timer = window.setTimeout(() => {
        researchTreeRecoveryTimersRef.current.delete(treeId);
        const eventVersion = researchTreeEventVersionRef.current.get(treeId) ?? 0;
        const detailRequestSeq =
          activeResearchTreeIdRef.current === treeId
            ? researchDetailRequestSeqRef.current + 1
            : null;
        if (detailRequestSeq !== null) {
          researchDetailRequestSeqRef.current = detailRequestSeq;
        }
        void getResearchTree(treeId)
          .then((detail) => {
            if ((researchTreeEventVersionRef.current.get(treeId) ?? 0) !== eventVersion) {
              scheduleResearchTreeRecovery(treeId);
              return;
            }

            const summary = researchSummaryFromDetail(detail);
            if (summary.archivedAt != null) {
              setResearchTrees((current) => removeResearchTreeSummary(current, treeId));
              setArchivedResearchTrees((current) =>
                upsertResearchTreeSummary(current, summary),
              );
            } else {
              setArchivedResearchTrees((current) =>
                removeResearchTreeSummary(current, treeId),
              );
              setResearchTrees((current) => upsertResearchTreeSummary(current, summary));
            }
            setResearchActivity((current) => replaceResearchActivityForTree(current, detail));

            for (const [nodeId, node] of researchNodeEventCacheRef.current) {
              if (node.treeId === treeId) {
                researchNodeEventCacheRef.current.delete(nodeId);
              }
            }
            for (const node of detail.nodes) {
              researchNodeEventCacheRef.current.set(node.id, node);
            }
            pruneResearchNavigationNodes(
              treeId,
              detail.nodes.map((node) => node.id),
            );

            if (
              detailRequestSeq !== null &&
              researchDetailRequestSeqRef.current === detailRequestSeq &&
              activeResearchTreeIdRef.current === treeId
            ) {
              setActiveResearchDetail((current) =>
                reconcileResearchTreeDetail(current, detail),
              );
              setActiveResearchDetailError(null);
            }
            if (summary.hasUnseenUpdate || summary.hasUnseenFailure) {
              void markVisibleResearchTreeViewedRef.current(treeId, {
                knownUnseen: true,
              }).catch(() => undefined);
            }
          })
          .catch(() => {
            if (removedResearchTreeIdsRef.current.has(treeId)) {
              return;
            }
            // The tree may have disappeared or a future backend mutation may
            // have invalidated the targeted read. Recover collection order and
            // selection with the authoritative, but much more expensive, path.
            scheduleResearchRefresh();
          });
      }, 200);
      researchTreeRecoveryTimersRef.current.set(treeId, timer);
    },
    [scheduleResearchRefresh],
  );
  const handleResearchEvent = useCallback(
    (rawEvent: SessionEvent) => {
      const parsed = parseResearchEvent(rawEvent);
      if (parsed.kind !== "event") {
        if (parsed.kind !== "notResearch") {
          scheduleResearchRefresh();
        }
        return;
      }

      const event: ParsedResearchEvent = parsed.event;
      if (event.type === "research.drafts.changed") {
        void refreshResearchDrafts(event.workspaceId);
        return;
      }
      if (event.type === "research.folders.changed") {
        void refreshResearchFolders();
        return;
      }
      if (event.type === "research.trash.changed") {
        void refreshResearchTrash();
        return;
      }
      const eventTreeId =
        "tree" in event
          ? event.tree.id
          : "treeId" in event
            ? event.treeId
            : "node" in event
              ? event.node.treeId
              : researchNodeEventCacheRef.current.get(event.nodeId)?.treeId ?? null;
      if (eventTreeId) {
        if (event.type !== "research.tree.removed") {
          removedResearchTreeIdsRef.current.delete(eventTreeId);
        }
        researchTreeEventVersionRef.current.set(
          eventTreeId,
          (researchTreeEventVersionRef.current.get(eventTreeId) ?? 0) + 1,
        );
      }

      const invalidateNavigationSnapshot = () => {
        const needsRecovery =
          researchNavRefreshInFlightRef.current > 0 ||
          researchNavigationRecoveryTimerRef.current !== null;
        researchNavRefreshSeqRef.current += 1;
        recentActivityRootRequestSeqRef.current += 1;
        if (needsRecovery) {
          // An event invalidated a pre-event collection snapshot. Retry after
          // the timeout passes without another event. Resetting the timer
          // prevents repeated list IPC during a streaming run.
          scheduleResearchNavigationRecovery();
        }
      };
      const invalidateVisibleDetailSnapshot = (treeId: string) => {
        if (
          activeResearchTreeIdRef.current === treeId &&
          activeResearchDetailRef.current?.tree.id === treeId
        ) {
          researchDetailRequestSeqRef.current += 1;
        }
      };
      const patchSummaryState = (
        treeId: string,
        patch: (summary: ResearchTreeSummary) => ResearchTreeSummary,
      ) => {
        if (archivedResearchTreesRef.current.some((tree) => tree.id === treeId)) {
          setArchivedResearchTrees((current) =>
            patchResearchTreeSummaries(current, patch),
          );
        } else {
          setResearchTrees((current) => patchResearchTreeSummaries(current, patch));
        }
      };
      const patchNode = (
        node: ResearchNode,
        timestamp: number,
        navigationChanged = true,
      ) => {
        const previous = researchNodeEventCacheRef.current.get(node.id);
        researchNodeEventCacheRef.current.set(node.id, node);
        if (navigationChanged) {
          invalidateNavigationSnapshot();
        }
        invalidateVisibleDetailSnapshot(node.treeId);
        setActiveResearchDetail((current) => patchResearchDetailNode(current, node));
        setResearchActivity((current) => upsertResearchActivity(current, node));
        const items = upsertRecentActivityResearchNode(recentActivityItemsRef.current, node);
        recentActivityItemsRef.current = items;
        setRecentActivityItems(items);
        if (previous) {
          const patchSummary = (summary: ResearchTreeSummary) =>
            patchResearchSummaryForNode(summary, previous, node, timestamp);
          patchSummaryState(node.treeId, patchSummary);
        }
        return previous;
      };
      switch (event.type) {
        case "research.tree.created": {
          invalidateNavigationSnapshot();
          const summary = researchSummaryFromDetail({ tree: event.tree, nodes: [event.node] });
          researchNodeEventCacheRef.current.set(event.node.id, event.node);
          if (summary.archivedAt != null) {
            setArchivedResearchTrees((current) =>
              upsertResearchTreeSummary(current, summary, true),
            );
          } else {
            setResearchTrees((current) =>
              upsertResearchTreeSummary(current, summary, true),
            );
          }
          setResearchActivity((current) => upsertResearchActivity(current, event.node));
          setRecentActivityItems((current) => {
            const next = upsertRecentActivityResearchNode(current, event.node);
            recentActivityItemsRef.current = next;
            return next;
          });
          break;
        }
        case "research.document.updated": {
          patchNode(event.node, event.timestamp);
          setActiveResearchDetail((current) => patchResearchDetailTree(current, event.tree));
          const patchSummary = (summary: ResearchTreeSummary) =>
            patchResearchSummaryTree(summary, event.tree);
          patchSummaryState(event.tree.id, patchSummary);
          break;
        }
        case "research.node.created": {
          const previous = patchNode(event.node, event.timestamp);
          if (!previous) {
            patchSummaryState(event.node.treeId, (summary) =>
              patchResearchSummaryForCreatedNode(summary, event.node, event.timestamp),
            );
          }
          scheduleResearchTreeRecovery(event.node.treeId);
          break;
        }
        case "research.node.updated": {
          const cached = researchNodeEventCacheRef.current.get(event.node.id);
          const lifecycleChanged =
            !cached ||
            nodeStatus(cached) !== nodeStatus(event.node) ||
            nodeRun(cached)?.completedAt !== nodeRun(event.node)?.completedAt ||
            cached.parentNodeId !== event.node.parentNodeId;
          const previous = patchNode(
            event.node,
            event.timestamp,
            lifecycleChanged,
          );
          if (lifecycleChanged || activeResearchDetailRef.current === null) {
            scheduleResearchTreeRecovery(event.node.treeId);
          }
          if (
            previous &&
            nodeRun(previous)?.completedAt !== nodeRun(event.node)?.completedAt &&
            nodeRun(event.node)?.completedAt != null
          ) {
            void markVisibleResearchTreeViewedRef.current(event.node.treeId, {
              knownUnseen: true,
            }).catch(() => undefined);
          }
          break;
        }
        case "research.recap.pending": {
          setRecapPendingNodeIds((current) => {
            if (current.has(event.nodeId) === event.pending) {
              return current;
            }
            const next = new Set(current);
            if (event.pending) next.add(event.nodeId);
            else next.delete(event.nodeId);
            return next;
          });
          break;
        }
        case "research.tree.updated": {
          invalidateNavigationSnapshot();
          invalidateVisibleDetailSnapshot(event.tree.id);
          setActiveResearchDetail((current) => patchResearchDetailTree(current, event.tree));
          const patchSummary = (summary: ResearchTreeSummary) =>
            patchResearchSummaryTree(summary, event.tree);
          patchSummaryState(event.tree.id, patchSummary);
          break;
        }
        case "research.tree.archived":
        case "research.tree.restored": {
          invalidateResearchHighlights();
          invalidateNavigationSnapshot();
          invalidateVisibleDetailSnapshot(event.tree.id);
          setActiveResearchDetail((current) => patchResearchDetailTree(current, event.tree));
          // Refetch navigation so the archived and active tree lists stay
          // exact. Restoring a tree resets the loaded tail to refetch its
          // activity rows.
          scheduleResearchRefresh({
            resetLoadedTail: event.type === "research.tree.restored",
          });
          if (event.type === "research.tree.archived") {
            pruneResearchTreeVisits((id) => id !== event.tree.id);
          }
          break;
        }
        case "research.highlight.created": {
          const cachedNode = researchNodeEventCacheRef.current.get(event.nodeId);
          if (cachedNode) {
            const node = addResearchNodeHighlight(cachedNode, event.highlight);
            researchNodeEventCacheRef.current.set(event.nodeId, node);
            invalidateVisibleDetailSnapshot(node.treeId);
          } else if (activeResearchDetailRef.current === null) {
            scheduleResearchRefresh();
          }
          setActiveResearchDetail((current) =>
            patchResearchDetailHighlightCreated(current, event.nodeId, event.highlight),
          );
          invalidateResearchHighlights();
          break;
        }
        case "research.highlights.removed": {
          const highlightIds = event.highlightIds;
          const cachedNode = researchNodeEventCacheRef.current.get(event.nodeId);
          if (cachedNode) {
            const node = removeResearchNodeHighlights(cachedNode, highlightIds);
            researchNodeEventCacheRef.current.set(event.nodeId, node);
            invalidateVisibleDetailSnapshot(node.treeId);
          } else if (activeResearchDetailRef.current === null) {
            scheduleResearchRefresh();
          }
          setActiveResearchDetail((current) =>
            patchResearchDetailHighlightsRemoved(current, event.nodeId, highlightIds),
          );
          invalidateResearchHighlights();
          break;
        }
        case "research.node.removed": {
          invalidateResearchHighlights();
          invalidateNavigationSnapshot();
          invalidateVisibleDetailSnapshot(event.treeId);
          const removedIds = new Set(event.removedNodeIds);
          const removedNodes = event.removedNodeIds.flatMap((nodeId) => {
            const node = researchNodeEventCacheRef.current.get(nodeId);
            return node ? [node] : [];
          });
          for (const nodeId of removedIds) {
            researchNodeEventCacheRef.current.delete(nodeId);
          }
          setActiveResearchDetail((current) =>
            removeResearchDetailNodes(current, event.treeId, removedIds),
          );
          setResearchActivity((current) => removeResearchNodes(current, removedIds));
          setRecentActivityItems((current) => {
            const next = current
              .filter((item) => !removedIds.has(item.nodeId))
              .map((item) =>
                item.children
                  ? {
                      ...item,
                      children: item.children.filter((child) => !removedIds.has(child.nodeId)),
                    }
                  : item,
              );
            recentActivityItemsRef.current = next;
            return next;
          });
          patchSummaryState(event.treeId, (summary) =>
            patchResearchSummaryForRemovedNodes(
              summary,
              event.treeId,
              removedNodes,
              event.timestamp,
            ),
          );
          scheduleResearchTreeRecovery(event.treeId);
          break;
        }
        case "research.tree.removed": {
          invalidateResearchHighlights();
          invalidateNavigationSnapshot();
          removedResearchTreeIdsRef.current.add(event.treeId);
          const pendingTimer = researchTreeRecoveryTimersRef.current.get(event.treeId);
          if (pendingTimer !== undefined) {
            window.clearTimeout(pendingTimer);
            researchTreeRecoveryTimersRef.current.delete(event.treeId);
          }
          setResearchTrees((current) => removeResearchTreeSummary(current, event.treeId));
          setArchivedResearchTrees((current) =>
            removeResearchTreeSummary(current, event.treeId),
          );
          setResearchActivity((current) => {
            const removedIds = current
              .filter((node) => node.treeId === event.treeId)
              .map((node) => node.id);
            return removeResearchNodes(current, removedIds);
          });
          setRecentActivityItems((current) => {
            const next = current.filter((item) => item.treeId !== event.treeId);
            recentActivityItemsRef.current = next;
            return next;
          });
          for (const [nodeId, node] of researchNodeEventCacheRef.current) {
            if (node.treeId === event.treeId) {
              researchNodeEventCacheRef.current.delete(nodeId);
            }
          }
          pruneResearchNavigation(
            [...researchTreesRef.current, ...archivedResearchTreesRef.current]
              .filter((tree) => tree.id !== event.treeId)
              .map((tree) => tree.id),
          );
          if (activeResearchTreeIdRef.current === event.treeId) {
            focusResearchHome();
          }
          pruneResearchTreeVisits((id) => id !== event.treeId);
          break;
        }
      }
    },
    [
      focusResearchHome,
      pruneResearchTreeVisits,
      scheduleResearchRefresh,
      scheduleResearchNavigationRecovery,
      scheduleResearchTreeRecovery,
    ],
  );
  return handleResearchEvent;
}
