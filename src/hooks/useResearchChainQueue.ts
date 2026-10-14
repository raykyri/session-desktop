import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { researchQueueAction } from "@session/shared/lib/researchBranchView";
import type { QueuedResearchFollowup } from "../lib/researchNavigation";
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
 * child it created is in the detail, or for QUEUE_CHILD_WAIT_MS. */
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
    if (!detail || archived) {
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
      onFork(tailId, item.prompt, null, true, null, item.images ?? [])
        .then((child) => {
          awaitChainChild(headId, child.id);
          updateQueue(headId, (current) => current.filter((entry) => entry.id !== item.id));
        })
        .catch((err) => {
          inFlight.delete(headId);
          const message = err instanceof Error ? err.message : String(err);
          updateQueue(headId, (current) =>
            current.map((entry) => (entry.id === item.id ? { ...entry, failed: message } : entry)),
          );
        });
    }
  }, [archived, awaitChainChild, detail, nodeById, onFork, queueReleases, queues, updateQueue]);

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
