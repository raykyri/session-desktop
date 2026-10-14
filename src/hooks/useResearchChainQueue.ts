import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { researchQueueAction } from "@session/shared/lib/researchBranchView";
import { subscribeResearchQueuedFollowups, type QueuedResearchFollowup } from "../lib/researchNavigation";
import {
  RESEARCH_QUEUE_CLAIM_CONFIRM_MS,
  RESEARCH_QUEUE_LEASE_KEY,
  RESEARCH_QUEUE_LEASE_RENEW_MS,
  claimResearchQueue,
  releaseResearchQueue,
} from "../lib/researchQueueDispatch";
import type { createResearchThreadPersistence } from "../lib/researchThreadPersistence";
import { withoutKeys } from "@session/shared/lib/researchThreadView";
import type { NodeAnchor, ResearchImageAttachment, ResearchNode, ResearchTreeDetail } from "../types";

const EMPTY_QUEUE: QueuedResearchFollowup[] = [];
/** How long a sent queued follow-up keeps its chain blocked while waiting
 * for the new node to appear in the tree detail. */
const QUEUE_CHILD_WAIT_MS = 15_000;

/** The client-side queues of the thread page's chains: follow-ups asked
 * while a chain's last answer runs, keyed by chain head and persisted per
 * tree. Each chain's first item is sent once its tail completes (see
 * researchQueueAction); a chain stays blocked from the next send until the
 * child it created is in the detail, or for QUEUE_CHILD_WAIT_MS. With the
 * thread open in several windows, each shows the queues another window
 * stores, and only the window holding the tree's lease sends
 * (researchQueueDispatch.ts). */
export function useResearchChainQueue({
  treeId,
  navigationPersistence,
  detail,
  archived,
  nodeById,
  onFork,
  focusComposer,
}: {
  treeId: string | null;
  navigationPersistence: ReturnType<typeof createResearchThreadPersistence>;
  detail: ResearchTreeDetail | null;
  archived: boolean;
  nodeById: ReadonlyMap<string, ResearchNode>;
  onFork: (
    parentNodeId: string,
    prompt: string,
    anchor?: NodeAnchor | null,
    inline?: boolean,
    replacesNodeId?: string | null,
    images?: readonly ResearchImageAttachment[],
  ) => Promise<ResearchNode>;
  /** Focuses the ask box of the chain headed by `headId`. Stable. */
  focusComposer: (headId: string) => void;
}) {
  const [queues, setQueues] = useState<Record<string, QueuedResearchFollowup[]>>({});
  const queuesRef = useRef(queues);
  queuesRef.current = queues;
  const treeIdRef = useRef(treeId);
  treeIdRef.current = treeId;

  /** Replaces the queues with the ones a tree had stored. */
  const restoreQueues = useCallback((stored: Record<string, QueuedResearchFollowup[]>) => {
    setQueues({ ...stored });
  }, []);

  const updateQueue = useCallback(
    (headId: string, transform: (queue: QueuedResearchFollowup[]) => QueuedResearchFollowup[]) => {
      const current = queuesRef.current;
      const next = transform(current[headId] ?? EMPTY_QUEUE);
      const updated = next.length === 0 ? withoutKeys(current, [headId]) : { ...current, [headId]: next };
      queuesRef.current = updated;
      setQueues(updated);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordQueue(currentTreeId, headId, next);
      }
    },
    [navigationPersistence],
  );

  // Per chain head, the follow-up last sent from it: `true` while the fork
  // request runs, then the new child's id until the detail includes it. The
  // chain's tail is stale until then, so nothing else is sent from it.
  const queueInFlightRef = useRef(new Map<string, string | true>());
  // Items this window sent. Another window's write can carry one that it
  // had not yet seen removed; it is dropped rather than sent again.
  const sentItemIdsRef = useRef(new Set<string>());

  // Another window changed this tree's queues: show what it stored.
  useEffect(() => {
    if (!treeId) {
      return;
    }
    return subscribeResearchQueuedFollowups((treeIds) => {
      if (!treeIds.has(treeId)) {
        return;
      }
      const stored = navigationPersistence.store[treeId]?.queuedFollowups ?? {};
      const sent = sentItemIdsRef.current;
      const next = Object.fromEntries(
        Object.entries(stored).flatMap(([headId, queue]) => {
          const unsent = queue.filter((item) => !sent.has(item.id));
          return unsent.length > 0 ? [[headId, unsent]] : [];
        }),
      );
      queuesRef.current = next;
      setQueues(next);
      for (const [headId, queue] of Object.entries(stored)) {
        if ((next[headId]?.length ?? 0) !== queue.length) {
          navigationPersistence.recordQueue(treeId, headId, next[headId] ?? []);
        }
      }
    });
  }, [navigationPersistence, treeId]);

  // Whether this window holds the tree's lease and so sends its queues.
  const [dispatching, setDispatching] = useState(false);
  useEffect(() => {
    if (!treeId) {
      return;
    }
    let confirmTimer: number | null = null;
    const evaluate = () => {
      if (confirmTimer !== null) {
        window.clearTimeout(confirmTimer);
        confirmTimer = null;
      }
      const { dispatch, confirm } = claimResearchQueue(treeId);
      setDispatching(dispatch);
      if (confirm) {
        confirmTimer = window.setTimeout(evaluate, RESEARCH_QUEUE_CLAIM_CONFIRM_MS);
      }
    };
    // A send whose request is still running keeps the lease until it
    // expires, so another window does not send the item again before this
    // one removes it.
    const release = () => {
      if (![...queueInFlightRef.current.values()].includes(true)) {
        releaseResearchQueue(treeId);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === RESEARCH_QUEUE_LEASE_KEY || event.key === null) {
        evaluate();
      }
    };
    evaluate();
    const renewal = window.setInterval(evaluate, RESEARCH_QUEUE_LEASE_RENEW_MS);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", release);
    return () => {
      if (confirmTimer !== null) {
        window.clearTimeout(confirmTimer);
      }
      window.clearInterval(renewal);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", release);
      release();
      setDispatching(false);
    };
  }, [treeId]);
  const [queueReleases, setQueueReleases] = useState(0);
  const awaitChainChild = useCallback((headId: string, childId: string) => {
    const inFlight = queueInFlightRef.current;
    inFlight.set(headId, childId);
    window.setTimeout(() => {
      if (inFlight.get(headId) === childId) {
        inFlight.delete(headId);
        setQueueReleases((count) => count + 1);
      }
    }, QUEUE_CHILD_WAIT_MS);
  }, []);
  /** Whether a follow-up sent from the chain still blocks the next send. */
  const chainSendInFlight = useCallback((headId: string) => queueInFlightRef.current.has(headId), []);

  // Send each chain's first queued follow-up once its tail completes. A
  // chain stays blocked from the send until the child it created is in the
  // detail (see researchQueueAction); a child that never arrives releases
  // the chain after QUEUE_CHILD_WAIT_MS.
  useEffect(() => {
    if (!detail || archived || !dispatching) {
      return;
    }
    const inFlight = queueInFlightRef.current;
    for (const [headId, pending] of [...inFlight]) {
      if (typeof pending === "string" && nodeById.has(pending)) {
        inFlight.delete(headId);
      }
    }
    for (const [headId, queue] of Object.entries(queues)) {
      const action = researchQueueAction(detail.nodes, headId, queue, inFlight.get(headId));
      if (action.kind === "clear") {
        updateQueue(headId, () => []);
        continue;
      }
      if (action.kind !== "send") {
        continue;
      }
      const { item, tailId } = action;
      inFlight.set(headId, true);
      sentItemIdsRef.current.add(item.id);
      onFork(tailId, item.prompt, null, true, null, item.images ?? [])
        .then((child) => {
          awaitChainChild(headId, child.id);
          updateQueue(headId, (current) => current.filter((entry) => entry.id !== item.id));
        })
        .catch((err) => {
          inFlight.delete(headId);
          sentItemIdsRef.current.delete(item.id);
          const message = err instanceof Error ? err.message : String(err);
          updateQueue(headId, (current) =>
            current.map((entry) => (entry.id === item.id ? { ...entry, failed: message } : entry)),
          );
        });
    }
  }, [archived, awaitChainChild, detail, dispatching, nodeById, onFork, queueReleases, queues, updateQueue]);

  // After Retry on a queued question, focus that drops to the page (the
  // question was sent and its item, with the focused button, went away)
  // moves to the chain's composer.
  const queueRefocusRef = useRef<{ headId: string; itemId: string } | null>(null);
  useLayoutEffect(() => {
    const pending = queueRefocusRef.current;
    if (!pending || (queuesRef.current[pending.headId] ?? EMPTY_QUEUE).some((item) => item.id === pending.itemId)) {
      return;
    }
    queueRefocusRef.current = null;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      focusComposer(pending.headId);
    }
  });

  /** Clears a failed item's error so the queue sends it again; once it is
   * sent, focus that dropped to the page goes to the chain's ask box. */
  const retryQueued = useCallback(
    (headId: string, itemId: string) => {
      queueRefocusRef.current = { headId, itemId };
      updateQueue(headId, (queue) =>
        queue.map((entry) => (entry.id === itemId ? { ...entry, failed: undefined } : entry)),
      );
    },
    [updateQueue],
  );

  return {
    queues,
    /** The latest queues, for callbacks that keep a stable identity. */
    queuesRef,
    restoreQueues,
    updateQueue,
    retryQueued,
    awaitChainChild,
    chainSendInFlight,
  };
}
