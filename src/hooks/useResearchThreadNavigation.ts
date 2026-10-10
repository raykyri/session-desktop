import { useEffect, useLayoutEffect, useRef } from "react";
import {
  createResearchComposerDraftRestoration,
  createResearchThreadPersistence,
} from "../lib/researchThreadPersistence";
import type { ResearchHighlightAnchor, ResearchNodeContent } from "../types";

type Persistence = ReturnType<typeof createResearchThreadPersistence>;
type DraftRestoration = ReturnType<typeof createResearchComposerDraftRestoration>;
type PendingBranch = { nodeId: string; anchor: ResearchHighlightAnchor };

/** Own the shared store, durable writes, and final scroll capture for one thread page mount. */
export function useResearchThreadNavigation(
  captureScroll: (persistence: Persistence) => void,
) {
  const owner = useRef<Persistence | null>(null);
  if (!owner.current) owner.current = createResearchThreadPersistence();
  const latestCapture = useRef(captureScroll);
  useLayoutEffect(() => {
    latestCapture.current = captureScroll;
  });
  useEffect(() => {
    const persistence = owner.current!;
    const flush = () => {
      latestCapture.current(persistence);
      persistence.flush();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  return owner.current;
}

/** Persists the root composer's text and an unsent branch's passage and text
 * per tree across thread page unmounts. On mount, a branch saved under one of
 * `chainNodeIds` reopens after its source answer loads, unless another pending
 * branch is already open. Call after the thread page's tree-reset effect so
 * the reset does not clear the restored branch. */
export function useResearchComposerDrafts({
  persistence,
  treeId,
  mainText,
  pendingBranch,
  pendingBranchText,
  pendingBranchOpen,
  chainNodeIds,
  contentByNode,
  setMainText,
  restorePendingBranch,
}: {
  persistence: Persistence;
  treeId: string | null;
  mainText: string;
  pendingBranch: PendingBranch | null;
  pendingBranchText: string;
  pendingBranchOpen: boolean;
  chainNodeIds: string[];
  contentByNode: Record<string, ResearchNodeContent>;
  setMainText: (text: string) => void;
  restorePendingBranch: (nodeId: string, anchor: ResearchHighlightAnchor, text: string) => void;
}) {
  const restoring = useRef<DraftRestoration | null>(null);
  if (!restoring.current) {
    restoring.current = createResearchComposerDraftRestoration(persistence.store);
  }
  const setMainTextRef = useRef(setMainText);
  setMainTextRef.current = setMainText;
  const restorePendingBranchRef = useRef(restorePendingBranch);
  restorePendingBranchRef.current = restorePendingBranch;
  const pendingBranchRestoredRef = useRef(false);

  useEffect(() => {
    setMainTextRef.current(restoring.current!.restore(treeId));
    pendingBranchRestoredRef.current = false;
  }, [persistence, treeId]);

  useEffect(() => {
    if (!treeId || pendingBranchRestoredRef.current || chainNodeIds.length === 0) return;
    if (pendingBranchOpen) {
      pendingBranchRestoredRef.current = true;
      return;
    }
    const saved = persistence.store[treeId]?.askByNode;
    for (const nodeId of chainNodeIds) {
      const branch = saved?.[nodeId];
      if (!branch) continue;
      // Wait for the passage's answer before reopening the branch on it.
      if (!contentByNode[nodeId]?.responseRevision) return;
      pendingBranchRestoredRef.current = true;
      restorePendingBranchRef.current(nodeId, branch.anchor, branch.text);
      return;
    }
    // Restore a pending branch only on mount. Selecting another message during the visit
    // does not reopen its saved branch.
    pendingBranchRestoredRef.current = true;
  }, [chainNodeIds, contentByNode, pendingBranchOpen, persistence, treeId]);

  useEffect(() => {
    if (!treeId) return;
    if (!restoring.current!.canPersist(treeId, mainText)) return;
    persistence.recordDraft(treeId, mainText);
  }, [mainText, persistence, treeId]);

  const pendingBranchContentLoaded = pendingBranch ? Boolean(contentByNode[pendingBranch.nodeId]) : false;
  useEffect(() => {
    // A tree reset commits asynchronously; an outgoing pending branch still present in
    // that render must not be written under the incoming tree.
    if (pendingBranch && treeId && pendingBranchContentLoaded && chainNodeIds.includes(pendingBranch.nodeId)) {
      persistence.recordPendingBranch(treeId, pendingBranch.nodeId, pendingBranch.anchor, pendingBranchText);
    }
  }, [chainNodeIds, pendingBranch, pendingBranchContentLoaded, pendingBranchText, persistence, treeId]);
}
