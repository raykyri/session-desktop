import { useCallback, useEffect, useRef, useState } from "react";
import { getResearchNodeContent } from "../lib/api";
import { isActiveResearchStatus } from "../lib/researchChains";
import type { ResearchLevel } from "../lib/researchColumns";
import {
  createContentRefresh,
  reuseUnchangedContent,
  subscribeResearchContentChanged,
  type ContentRefresh,
} from "../lib/researchContentRefresh";
import { nodeRecap, nodeResponseSnapshotAt, nodeStatus } from "../lib/researchNodeTypes";
import { withoutKeys } from "../lib/researchThreadView";
import type { ResearchHighlight, ResearchNode, ResearchNodeContent, ResearchTreeDetail } from "../types";

/** Minimum spacing between full content fetches of one answer while
 * `research.content.changed` signals arrive (every streamed delta for SDK
 * runs, every transcript line for pane runs). */
const CONTENT_REFETCH_MIN_INTERVAL_MS = 1_000;
/** While a run is active, how long after its last fetch the content is
 * refetched without a signal. */
const ACTIVE_CONTENT_FALLBACK_POLL_MS = 10_000;

/** The (status, snapshot, recap) stamp a node's content is fetched under. */
function contentStamp(node: ResearchNode) {
  return `${nodeStatus(node)}:${nodeResponseSnapshotAt(node) ?? 0}:${nodeRecap(node)?.id ?? nodeRecap(node)?.responseRevision ?? ""}`;
}

/** Loads the answers of the thread page's open messages (`chainNodes`) and
 * keeps them current: a fetch per answer whose status, snapshot or recap
 * changed, refetches on `research.content.changed` signals (spaced by
 * CONTENT_REFETCH_MIN_INTERVAL_MS), a fallback poll while a run is active,
 * and retries after errors. The cache holds only the open levels' messages
 * and `chainNodes`. */
export function useResearchContentLoader({
  detail,
  levels,
  chainNodeIds,
  chainNodes,
}: {
  detail: ResearchTreeDetail | null;
  levels: readonly ResearchLevel[];
  /** The answers on screen, with a stable identity while they do not change. */
  chainNodeIds: readonly string[];
  /** The `chainNodeIds` present in the tree. */
  chainNodes: readonly ResearchNode[];
}) {
  // Loaded answers, keyed by node id. Pruned to the open levels' chains.
  const [contentByNode, setContentByNode] = useState<Record<string, ResearchNodeContent>>({});
  const [contentErrorByNode, setContentErrorByNode] = useState<Record<string, string>>({});
  const [contentLoadNonce, setContentLoadNonce] = useState(0);
  // The loading effect reads the tree through this ref so a routine detail
  // replacement (every research event rebuilds the object) does not restart
  // the effect and refetch content that has not changed.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const contentByNodeRef = useRef(contentByNode);
  contentByNodeRef.current = contentByNode;
  const contentErrorByNodeRef = useRef(contentErrorByNode);
  contentErrorByNodeRef.current = contentErrorByNode;
  // The stamp each cached content was fetched under, so the loader can tell
  // a cache hit from a stale entry without refetching unchanged answers every
  // time the open levels recompute.
  const fetchStampByNodeRef = useRef(new Map<string, string>());
  const chainKey = chainNodeIds.join("\n");
  // Refetch when a run finishes, its snapshot is saved, or its recap is available.
  // Other detail updates do not need to restart the content loaders.
  const chainStatusKey = chainNodes.map((node) => `${node.id}:${contentStamp(node)}`).join("\n");

  // Highlight mutations are announced as research events but do not replace
  // the response snapshot. Mirror their refreshed node metadata into each
  // loaded answer so another window's changes reach the thread. Bail on
  // unchanged id lists: every research event rebuilds the highlights arrays,
  // and adopting each fresh identity re-ran the paint effect's text walk.
  useEffect(() => {
    if (!detail) {
      return;
    }
    setContentByNode((current) => {
      let changed = false;
      const next: Record<string, ResearchNodeContent> = { ...current };
      for (const node of detail.nodes) {
        const entry = current[node.id];
        if (!entry) {
          continue;
        }
        const previous = entry.node.highlights ?? [];
        const fresh = node.highlights ?? [];
        if (
          previous.length === fresh.length &&
          previous.every((highlight, index) => highlight.id === fresh[index].id)
        ) {
          continue;
        }
        next[node.id] = {
          ...entry,
          node: { ...entry.node, highlights: node.highlights },
        };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [detail]);

  // Bound the cache to the open levels' messages.
  useEffect(() => {
    const keep = new Set([...levels.flatMap((level) => level.chainIds), ...chainNodeIds]);
    const prune = <T,>(current: Record<string, T>) =>
      withoutKeys(current, Object.keys(current).filter((key) => !keep.has(key)));
    setContentByNode(prune);
    setContentErrorByNode(prune);
    for (const key of [...fetchStampByNodeRef.current.keys()]) {
      if (!keep.has(key)) {
        fetchStampByNodeRef.current.delete(key);
      }
    }
    // chainKey stands for chainNodeIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, levels]);

  useEffect(() => {
    if (chainNodeIds.length === 0) {
      return;
    }
    let cancelled = false;
    // Fallback-poll and error-retry timers; each fires a refresh request.
    const timers = new Map<string, number>();
    const errorCounts = new Map<string, number>();
    const refreshes = new Map<string, ContentRefresh>();
    const stampFor = (nodeId: string) => {
      const node = detailRef.current?.nodes.find((candidate) => candidate.id === nodeId);
      return node ? contentStamp(node) : "";
    };
    const clearError = (nodeId: string) =>
      setContentErrorByNode((current) => withoutKeys(current, [nodeId]));
    const clearTimer = (nodeId: string) => {
      const timer = timers.get(nodeId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(nodeId);
      }
    };
    const requestRefresh = (nodeId: string) => refreshFor(nodeId).request();
    const armTimer = (nodeId: string, delay: number) => {
      clearTimer(nodeId);
      timers.set(
        nodeId,
        window.setTimeout(() => {
          timers.delete(nodeId);
          requestRefresh(nodeId);
        }, delay),
      );
    };
    const load = async (nodeId: string) => {
      // Capture the stamp before fetching. A state transition during the fetch
      // restarts this effect and refetches with the new stamp.
      const stamp = stampFor(nodeId);
      clearTimer(nodeId);
      try {
        const next = await getResearchNodeContent(nodeId);
        if (cancelled) {
          return;
        }
        errorCounts.delete(nodeId);
        fetchStampByNodeRef.current.set(nodeId, stamp);
        clearError(nodeId);
        setContentByNode((current) => {
          const merged = reuseUnchangedContent(current[nodeId], next);
          return merged === current[nodeId] ? current : { ...current, [nodeId]: merged };
        });
        if (isActiveResearchStatus(nodeStatus(next.node))) {
          // `research.content.changed` drives refetches while the answer
          // streams; this only covers a signal that never arrives.
          armTimer(nodeId, ACTIVE_CONTENT_FALLBACK_POLL_MS);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        setContentErrorByNode((current) => ({
          ...current,
          [nodeId]: err instanceof Error ? err.message : String(err),
        }));
        const knownNode = detailRef.current?.nodes.find(
          (candidate) => candidate.id === nodeId,
        );
        const attempts = (errorCounts.get(nodeId) ?? 0) + 1;
        errorCounts.set(nodeId, attempts);
        const isActive = knownNode && isActiveResearchStatus(nodeStatus(knownNode));
        if (isActive || attempts <= 5) {
          armTimer(nodeId, Math.min(5000, 1000 * attempts));
        }
      }
    };
    const refreshFor = (nodeId: string) => {
      let refresh = refreshes.get(nodeId);
      if (!refresh) {
        refresh = createContentRefresh(() => load(nodeId), CONTENT_REFETCH_MIN_INTERVAL_MS, {
          now: () => performance.now(),
          setTimeout: (callback, ms) => window.setTimeout(callback, ms),
          clearTimeout: (handle) => window.clearTimeout(handle as number),
        });
        refreshes.set(nodeId, refresh);
      }
      return refresh;
    };
    const unsubscribe = subscribeResearchContentChanged((nodeId) => {
      if (chainNodeIds.includes(nodeId)) {
        requestRefresh(nodeId);
      }
    });
    for (const nodeId of chainNodeIds) {
      const node = detailRef.current?.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        // A just-created branch the next detail refresh has not delivered.
        continue;
      }
      const hasContent = Boolean(contentByNodeRef.current[nodeId]);
      const hasError = Boolean(contentErrorByNodeRef.current[nodeId]);
      if (
        !hasContent ||
        hasError ||
        fetchStampByNodeRef.current.get(nodeId) !== stampFor(nodeId)
      ) {
        // A restart is a fresh load for this turn (status transition,
        // snapshot landing, retry): a failure reported by the previous run
        // must not sit on screen while this one is in flight.
        clearError(nodeId);
        requestRefresh(nodeId);
      } else if (isActiveResearchStatus(nodeStatus(node))) {
        // The cleanup above dropped this still-streaming turn's fallback
        // timer and any trailing refetch for a signal that arrived during an
        // in-flight fetch. Fetch once to cover that signal; the fetch re-arms
        // the fallback timer.
        requestRefresh(nodeId);
      }
    }
    return () => {
      cancelled = true;
      unsubscribe();
      for (const refresh of refreshes.values()) {
        refresh.dispose();
      }
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
    };
    // Keyed on the chains' statuses and snapshot stamps rather than the
    // detail object: streaming runs replace `detail` on every event, and
    // restarting this effect for each replacement refetched and reparsed
    // unchanged content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, chainStatusKey, contentLoadNonce]);

  /** Fetches every open answer again (the in-pane Retry). */
  const retryContentLoad = useCallback(() => setContentLoadNonce((value) => value + 1), []);

  /** Drops `nodeId`'s loaded answer and fetches it again: its snapshot was
   * replaced, and the old revision must not show meanwhile. */
  const reloadContent = useCallback((nodeId: string) => {
    setContentByNode((current) => withoutKeys(current, [nodeId]));
    fetchStampByNodeRef.current.delete(nodeId);
    setContentLoadNonce((value) => value + 1);
  }, []);

  /** Applies an optimistic highlight mutation to a loaded answer. */
  const patchNodeHighlights = useCallback(
    (nodeId: string, transform: (highlights: ResearchHighlight[]) => ResearchHighlight[]) => {
      setContentByNode((current) => {
        const entry = current[nodeId];
        if (!entry) {
          return current;
        }
        return {
          ...current,
          [nodeId]: {
            ...entry,
            node: {
              ...entry.node,
              highlights: transform(entry.node.highlights ?? []),
            },
          },
        };
      });
    },
    [],
  );

  /** Replaces a loaded answer's node (a regenerated recap). */
  const replaceContentNode = useCallback((node: ResearchNode) => {
    setContentByNode((current) => {
      const content = current[node.id];
      return content ? { ...current, [node.id]: { ...content, node } } : current;
    });
  }, []);

  return {
    contentByNode,
    contentErrorByNode,
    /** The latest `contentByNode`, for callbacks that keep a stable identity. */
    contentByNodeRef,
    retryContentLoad,
    reloadContent,
    patchNodeHighlights,
    replaceContentNode,
  };
}
