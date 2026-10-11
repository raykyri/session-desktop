import { useCallback, useEffect, useRef, useState } from "react";
import { canRerunResearchNode, inlineChainFor, isActiveResearchStatus } from "../lib/researchChains";
import { nodeStatus } from "../lib/researchNodeTypes";
import type { ResearchNode } from "../types";

/** Whether another answer in `nodeId`'s conversation is running or queued. */
function conversationBusy(nodes: readonly ResearchNode[], byId: (id: string) => ResearchNode | undefined, nodeId: string) {
  return inlineChainFor(nodes, nodeId).some((id) => {
    const node = byId(id);
    return id !== nodeId && Boolean(node) && isActiveResearchStatus(nodeStatus(node!));
  });
}

/** Stop, Retry and Rerun for the thread page's answers. One stop request and
 * one relaunch request run at a time (each guarded against double entry from
 * two controls). A relaunch — a retry of a failed or cancelled run, a rerun
 * that replaces a complete answer — waits while another answer in its
 * conversation runs, and starts once none does. */
export function useResearchRunControls({
  nodes,
  nodeById,
  onCancel,
  onRetryNode,
  onRerunNode,
  onToast,
  onError,
}: {
  /** The tree's nodes, with the ones created a moment ago. */
  nodes: ResearchNode[];
  nodeById: ReadonlyMap<string, ResearchNode>;
  onCancel: (nodeId: string) => Promise<void>;
  onRetryNode: (nodeId: string) => Promise<void>;
  onRerunNode: (nodeId: string) => Promise<void>;
  onToast: (message: string, tone?: "normal" | "warning") => void;
  onError: (message: string) => void;
}) {
  // Retries waiting for the running answer in their conversation.
  const [queuedRetries, setQueuedRetries] = useState<ReadonlySet<string>>(() => new Set());
  const [retryingNodeId, setRetryingNodeId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequestInFlightRef = useRef(false);
  const retryRequestInFlightRef = useRef(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const callbacksRef = useRef({ onCancel, onRetryNode, onRerunNode, onToast, onError });
  callbacksRef.current = { onCancel, onRetryNode, onRerunNode, onToast, onError };

  const handleCancelNode = useCallback((nodeId: string) => {
    if (cancelRequestInFlightRef.current) {
      return;
    }
    cancelRequestInFlightRef.current = true;
    setCancelling(true);
    callbacksRef.current
      .onCancel(nodeId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // Completion can beat the click to the backend. The desired stopped
        // state is already reached; genuine cleanup failures still surface.
        if (message !== "research run is not active") {
          callbacksRef.current.onError(message);
        }
      })
      .finally(() => {
        cancelRequestInFlightRef.current = false;
        setCancelling(false);
      });
  }, []);

  // Relaunches a settled node in place: a retry for a failed or cancelled
  // run, a rerun (which replaces the answer) for a complete one.
  const handleRetryNode = useCallback((nodeId: string) => {
    if (retryRequestInFlightRef.current) {
      return;
    }
    const nodesNow = nodesRef.current;
    const target = nodesNow.find((candidate) => candidate.id === nodeId);
    const busy = conversationBusy(nodesNow, (id) => nodesNow.find((candidate) => candidate.id === id), nodeId);
    if (busy) {
      setQueuedRetries((current) => new Set(current).add(nodeId));
      callbacksRef.current.onToast("Queued. It runs after the running answer finishes.");
      return;
    }
    retryRequestInFlightRef.current = true;
    setRetryingNodeId(nodeId);
    const relaunch =
      target && nodeStatus(target) === "complete" ? callbacksRef.current.onRerunNode : callbacksRef.current.onRetryNode;
    relaunch(nodeId)
      .catch((err) => callbacksRef.current.onError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        retryRequestInFlightRef.current = false;
        setRetryingNodeId((current) => (current === nodeId ? null : current));
      });
  }, []);

  // Removing a queued retry brings the failed attempt back.
  const removeQueuedRetry = useCallback((nodeId: string) => {
    setQueuedRetries((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  }, []);

  // A queued retry or rerun starts once no other answer in its conversation
  // runs; one the node can no longer take is dropped.
  useEffect(() => {
    if (queuedRetries.size === 0) {
      return;
    }
    for (const nodeId of queuedRetries) {
      const node = nodeById.get(nodeId);
      if (!node || !canRerunResearchNode(node)) {
        removeQueuedRetry(nodeId);
        continue;
      }
      if (!conversationBusy(nodes, (id) => nodeById.get(id), nodeId)) {
        removeQueuedRetry(nodeId);
        handleRetryNode(nodeId);
      }
    }
  }, [handleRetryNode, nodeById, nodes, queuedRetries, removeQueuedRetry]);

  return {
    /** A stop request is in flight. */
    cancelling,
    /** The node whose retry or rerun request is in flight. */
    retryingNodeId,
    queuedRetries,
    handleCancelNode,
    handleRetryNode,
    removeQueuedRetry,
  };
}
