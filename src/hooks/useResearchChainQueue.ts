import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedResearchFollowup } from "@session/shared/lib/researchBranchView";
import { withoutKeys } from "@session/shared/lib/researchThreadView";
import { cancelResearchFollowup, listResearchFollowups, retryResearchFollowup } from "../lib/api";
import { queuedResearchFollowup, subscribeResearchQueueChanges } from "../lib/researchQueue";
import type { ResearchFollowupQueueItem } from "../types";

const EMPTY_QUEUE: QueuedResearchFollowup[] = [];

/** `queues` with the chain `headId` holding `items`; an empty queue is
 * removed. */
function withQueue(
  queues: Record<string, QueuedResearchFollowup[]>,
  headId: string,
  items: readonly ResearchFollowupQueueItem[],
): Record<string, QueuedResearchFollowup[]> {
  return items.length === 0
    ? withoutKeys(queues, [headId])
    : { ...queues, [headId]: items.map(queuedResearchFollowup) };
}

/** The queues of the thread page's chains: follow-ups asked while a chain's
 * last answer runs, keyed by chain head. The backend holds them, sends each
 * chain's first item once its last answer completes, and announces every
 * change (`research.queue.changed`); this hook loads the open tree's queues
 * and applies those changes, so every window shows the same queues. */
export function useResearchChainQueue({
  treeId,
  focusComposer,
}: {
  treeId: string | null;
  /** Focuses the ask box of the chain headed by `headId`. Stable. */
  focusComposer: (headId: string) => void;
}) {
  const [queues, setQueues] = useState<Record<string, QueuedResearchFollowup[]>>({});
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  /** Shows the backend's queue of one chain. */
  const applyQueue = useCallback((headId: string, items: readonly ResearchFollowupQueueItem[]) => {
    setQueues((current) => {
      const next = withQueue(current, headId, items);
      queuesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    setQueues({});
    queuesRef.current = {};
    if (!treeId) {
      return;
    }
    let cancelled = false;
    // Chains whose queue an event replaced after the list was requested:
    // the event is newer than the list.
    const changed = new Set<string>();
    const unsubscribe = subscribeResearchQueueChanges((event) => {
      if (event.treeId !== treeId) {
        return;
      }
      changed.add(event.headNodeId);
      applyQueue(event.headNodeId, event.items);
    });
    listResearchFollowups(treeId)
      .then((stored) => {
        if (cancelled) {
          return;
        }
        for (const [headId, items] of Object.entries(stored)) {
          if (!changed.has(headId)) {
            applyQueue(headId, items);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyQueue, treeId]);

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

  /** Removes a queued question; the ones after it move up. Rejects with
   * the backend's message when the cancel fails. */
  const cancelQueued = useCallback(
    async (headId: string, itemId: string) => {
      applyQueue(headId, await cancelResearchFollowup(itemId));
    },
    [applyQueue],
  );

  /** Clears a refused question's reason so the backend sends it again; once
   * it is sent, focus that dropped to the page goes to the chain's ask
   * box. */
  const retryQueued = useCallback(
    async (headId: string, itemId: string) => {
      queueRefocusRef.current = { headId, itemId };
      try {
        applyQueue(headId, await retryResearchFollowup(itemId));
      } catch (err) {
        queueRefocusRef.current = null;
        throw err;
      }
    },
    [applyQueue],
  );

  /** Shows a question the backend just queued, before its event arrives. */
  const showQueued = useCallback((item: ResearchFollowupQueueItem) => {
    setQueues((current) => {
      const queue = current[item.headNodeId] ?? EMPTY_QUEUE;
      if (queue.some((entry) => entry.id === item.id)) {
        return current;
      }
      const next = { ...current, [item.headNodeId]: [...queue, queuedResearchFollowup(item)] };
      queuesRef.current = next;
      return next;
    });
  }, []);

  return {
    queues,
    /** The latest queues, for callbacks that keep a stable identity. */
    queuesRef,
    cancelQueued,
    retryQueued,
    showQueued,
  };
}
