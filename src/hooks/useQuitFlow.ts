import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ExitDialogState, ExitPreflightRequest } from "../appTypes";
import { cancelResearchNode, confirmAppExit } from "../lib/api";
import { waitForNextPaint } from "../lib/appHelpers";
import { isActiveResearchStatus } from "../lib/researchChains";
import { nodeStatus } from "../lib/researchNodeTypes";
import type { PaneInfo, ResearchNode } from "../types";

/**
 * Quitting: the backend's exit preflight request opens the Quit dialog when
 * panes or research runs are open, and confirming cancels the active research
 * runs before the app exits.
 */
export function useQuitFlow({
  panesRef,
  runningResearchCount,
  researchActivity,
  onError,
}: {
  panesRef: RefObject<PaneInfo[]>;
  runningResearchCount: number;
  researchActivity: ResearchNode[];
  onError: (message: string | null) => void;
}) {
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const [quitting, setQuitting] = useState(false);
  const quittingRef = useRef(false);
  const [exitPreflightRequest, setExitPreflightRequest] =
    useState<ExitPreflightRequest | null>(null);

  useEffect(() => {
    if (!exitPreflightRequest) {
      return;
    }
    // Quitting already warns that every tab, agent, and process will stop. Reusing
    // the per-pane close checks here used to fork one or two `ps` probes for every
    // ordinary pane, then discard the resulting dialog descriptions. With many tabs
    // that delayed this generic confirmation by hundreds of milliseconds.
    const paneCount = Math.max(exitPreflightRequest.paneCount, panesRef.current.length);
    const researchRunCount = Math.max(
      exitPreflightRequest.researchRunCount,
      runningResearchCount,
    );
    setExitPreflightRequest(null);
    setExitDialog(paneCount > 0 || researchRunCount > 0 ? { paneCount, researchRunCount } : null);
  }, [exitPreflightRequest, panesRef, runningResearchCount]);

  const confirmExit = useCallback(async () => {
    if (quittingRef.current) {
      return;
    }
    quittingRef.current = true;
    setQuitting(true);
    onError(null);
    // Let React commit the pending button and give WebKit a full paint before
    // AppKit begins the comparatively slow application teardown.
    await waitForNextPaint();
    try {
      const activeResearchNodeIds = researchActivity
        .filter((node) => isActiveResearchStatus(nodeStatus(node)))
        .map((node) => node.id);
      // Settled, not fail-fast: the activity snapshot can be moments stale, so
      // a run that finished (and lost its pane) in the meantime rejects with
      // "not active" — which must not abort the quit. Runs whose cancel truly
      // failed are killed by app teardown and reconciled to Failed on the next
      // start, so proceeding is safe either way.
      const cancellations = await Promise.allSettled(
        activeResearchNodeIds.map((nodeId) => cancelResearchNode(nodeId)),
      );
      for (const cancellation of cancellations) {
        if (cancellation.status === "rejected") {
          console.warn("research cancellation during quit failed:", cancellation.reason);
        }
      }
      await confirmAppExit();
    } catch (err) {
      quittingRef.current = false;
      setQuitting(false);
      setExitDialog(null);
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, researchActivity]);

  /** Closes the dialog unless the quit is already running. */
  const cancelExit = useCallback(() => {
    if (!quittingRef.current) {
      setExitDialog(null);
    }
  }, []);

  return {
    exitDialog,
    quitting,
    exitPreflightRequest,
    setExitPreflightRequest,
    confirmExit,
    cancelExit,
  };
}
