import { useEffect, useLayoutEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  createResearchComposerDraftRestoration,
  createResearchDocumentPersistence,
} from "../lib/researchDocumentPersistence";
import type { ResearchHighlightAnchor, ResearchNodeContent } from "../types";

type Persistence = ReturnType<typeof createResearchDocumentPersistence>;
type DraftRestoration = ReturnType<typeof createResearchComposerDraftRestoration>;
type Ask = { nodeId: string; anchor: ResearchHighlightAnchor };

/** Own the shared store, durable writes, and final scroll capture for one document mount. */
export function useResearchDocumentNavigation(
  captureScroll: (persistence: Persistence) => void,
) {
  const owner = useRef<Persistence | null>(null);
  if (!owner.current) owner.current = createResearchDocumentPersistence();
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

/** Call after the document's tree-reset effect so restoration wins over resets. */
export function useResearchComposerDrafts({
  persistence,
  treeId,
  followup,
  mode,
  ask,
  selectedNodeId,
  chainNodeIds,
  chainKey,
  revisionsKey,
  contentByNode,
  setFollowup,
  setMode,
  setAsk,
}: {
  persistence: Persistence;
  treeId: string | null;
  followup: string;
  mode: "thread" | "branch";
  ask: Ask | null;
  selectedNodeId: string | null;
  chainNodeIds: string[];
  chainKey: string;
  revisionsKey: string;
  contentByNode: Record<string, ResearchNodeContent>;
  setFollowup: Dispatch<SetStateAction<string>>;
  setMode: Dispatch<SetStateAction<"thread" | "branch">>;
  setAsk: Dispatch<SetStateAction<Ask | null>>;
}) {
  const restoring = useRef<DraftRestoration | null>(null);
  if (!restoring.current) {
    restoring.current = createResearchComposerDraftRestoration(persistence.store);
  }
  const restoringAsk = useRef(false);
  useEffect(() => {
    const saved = restoring.current!.restore(treeId);
    setFollowup(saved.text);
    setMode(saved.mode);
  }, [persistence, setFollowup, setMode, treeId]);

  useEffect(() => {
    restoringAsk.current = false;
    if (!treeId || chainNodeIds.length === 0 || ask) return;
    const asks = persistence.store[treeId]?.askByNode;
    const candidates = selectedNodeId
      ? [selectedNodeId, ...chainNodeIds.filter((id) => id !== selectedNodeId)]
      : chainNodeIds;
    for (const nodeId of candidates) {
      const saved = asks?.[nodeId];
      if (!saved || !contentByNode[nodeId]?.responseRevision) continue;
      restoringAsk.current = true;
      // Targeted restoration supersedes the ordinary draft; dismissing that
      // ask later must allow ordinary edits without waiting for the old text.
      restoring.current!.finish();
      setAsk({ nodeId, anchor: saved.anchor });
      if (saved.text) setFollowup((current) => current || saved.text);
      return;
    }
  }, [
    ask,
    chainKey,
    chainNodeIds,
    contentByNode,
    persistence,
    revisionsKey,
    selectedNodeId,
    setAsk,
    setFollowup,
    treeId,
  ]);

  useEffect(() => {
    if (!treeId || ask || restoringAsk.current) return;
    if (!restoring.current!.canPersist(treeId, followup, mode)) return;
    persistence.recordDraft(treeId, followup, mode);
  }, [ask, followup, mode, persistence, treeId]);

  const askContentLoaded = ask ? Boolean(contentByNode[ask.nodeId]) : false;
  useEffect(() => {
    // A tree reset commits asynchronously; an outgoing ask still present in that
    // render must not be written under the incoming tree.
    if (
      ask &&
      treeId &&
      askContentLoaded &&
      chainNodeIds.includes(ask.nodeId)
    ) {
      persistence.recordAsk(treeId, ask.nodeId, ask.anchor, followup);
    }
  }, [ask, askContentLoaded, chainNodeIds, followup, persistence, treeId]);
}
