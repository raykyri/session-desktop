import { useCallback, useRef, useState } from "react";
import { clearResearchTreeAttention } from "../lib/researchSnapshots";
import type {
  RecentResearchQuery,
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "../types";

/** The research tree the surface last showed, restored at startup. */
export const ACTIVE_RESEARCH_TREE_KEY = "session.active-research-tree.v1";

/**
 * The research data App renders: the sidebar's tree lists, running activity,
 * the feed's recent activity, recap jobs, and the open tree with its detail.
 * Each list has a ref that callbacks read at event time; the request
 * sequence refs let a newer fetch or event invalidate an in-flight one.
 */
export function useResearchData() {
  const [researchTrees, setResearchTrees] = useState<ResearchTreeSummary[]>([]);
  const [archivedResearchTrees, setArchivedResearchTrees] = useState<ResearchTreeSummary[]>([]);
  // Read by mark-viewed acknowledgment (a stable callback) to decide whether
  // any attention badge was actually lit without threading the lists through
  // its dependencies.
  const researchTreesRef = useRef(researchTrees);
  const archivedResearchTreesRef = useRef(archivedResearchTrees);
  researchTreesRef.current = researchTrees;
  archivedResearchTreesRef.current = archivedResearchTrees;
  const [researchActivity, setResearchActivity] = useState<ResearchNode[]>([]);
  const [recentActivityItems, setRecentActivityItems] = useState<RecentResearchQuery[]>([]);
  // Writers also set the ref, so a later event in the same batch builds on
  // their result.
  const recentActivityItemsRef = useRef(recentActivityItems);
  recentActivityItemsRef.current = recentActivityItems;
  // Runs whose background summary job is in flight. Held only for the session:
  // the jobs die with the process, so a restart correctly shows no spinner.
  const [recapPendingNodeIds, setRecapPendingNodeIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const [activeResearchTreeId, setActiveResearchTreeId] = useState<string | null>(null);
  const activeResearchTreeIdRef = useRef(activeResearchTreeId);
  activeResearchTreeIdRef.current = activeResearchTreeId;
  const [activeResearchDetail, setActiveResearchDetail] = useState<ResearchTreeDetail | null>(null);
  const activeResearchDetailRef = useRef(activeResearchDetail);
  activeResearchDetailRef.current = activeResearchDetail;
  // Why activeResearchDetail is null after a failed tree fetch. Without it the
  // thread page shows an unexplained spinner forever: the content effect can't
  // run (no detail-derived node id), so no in-page retry can recover.
  const [activeResearchDetailError, setActiveResearchDetailError] = useState<string | null>(null);

  // Full-node events are authoritative and arrive more often than React
  // commits. Keep a synchronous cache so several events in one 16 ms batch
  // can compute lifecycle deltas in arrival order rather than all reading the
  // same pre-batch state snapshot.
  const researchNodeEventCacheRef = useRef(new Map<string, ResearchNode>());
  for (const node of researchActivity) {
    researchNodeEventCacheRef.current.set(node.id, node);
  }
  for (const node of activeResearchDetail?.nodes ?? []) {
    researchNodeEventCacheRef.current.set(node.id, node);
  }

  // A detail fetch applies only while its sequence is current.
  const researchDetailRequestSeqRef = useRef(0);
  const researchNavRefreshSeqRef = useRef(0);
  const researchNavRefreshInFlightRef = useRef(0);
  // Bumped by refreshes and events; a feed-root load that started before
  // one is fetched again.
  const recentActivityRootRequestSeqRef = useRef(0);
  const recentActivityHeadRequestSeqRef = useRef(0);

  /** Clears the open tree: no selection, detail or error, nothing restored. */
  const clearActiveResearchTree = useCallback(() => {
    activeResearchTreeIdRef.current = null;
    setActiveResearchTreeId(null);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
  }, []);

  /** Opens `treeId` (persisted for startup) with no detail loaded yet. */
  const setActiveResearchTree = useCallback((treeId: string) => {
    activeResearchTreeIdRef.current = treeId;
    setActiveResearchTreeId(treeId);
    localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, treeId);
  }, []);

  const clearResearchUnseen = useCallback((treeId: string) => {
    // Both attention flags: viewing acknowledges failures exactly like
    // ordinary settlements (the backend clears both by advancing
    // last_viewed_at). Clearing only the update dot left the sidebar and
    // mode-toggle "!" lit forever — mark_research_tree_viewed emits no
    // event, so no refetch ever corrected the local copy.
    setResearchTrees((current) => clearResearchTreeAttention(current, treeId));
    setArchivedResearchTrees((current) => clearResearchTreeAttention(current, treeId));
  }, []);

  return {
    researchTrees,
    setResearchTrees,
    researchTreesRef,
    archivedResearchTrees,
    setArchivedResearchTrees,
    archivedResearchTreesRef,
    researchActivity,
    setResearchActivity,
    recentActivityItems,
    setRecentActivityItems,
    recentActivityItemsRef,
    recapPendingNodeIds,
    setRecapPendingNodeIds,
    activeResearchTreeId,
    setActiveResearchTreeId,
    activeResearchTreeIdRef,
    activeResearchDetail,
    setActiveResearchDetail,
    activeResearchDetailRef,
    activeResearchDetailError,
    setActiveResearchDetailError,
    researchNodeEventCacheRef,
    researchDetailRequestSeqRef,
    researchNavRefreshSeqRef,
    researchNavRefreshInFlightRef,
    recentActivityRootRequestSeqRef,
    recentActivityHeadRequestSeqRef,
    clearActiveResearchTree,
    setActiveResearchTree,
    clearResearchUnseen,
  };
}

export type ResearchData = ReturnType<typeof useResearchData>;
