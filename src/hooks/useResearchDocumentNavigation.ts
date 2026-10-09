import { useEffect, useLayoutEffect, useRef } from "react";
import {
  createResearchComposerDraftRestoration,
  createResearchDocumentPersistence,
} from "../lib/researchDocumentPersistence";
import type { ResearchHighlightAnchor, ResearchNodeContent } from "../types";

type Persistence = ReturnType<typeof createResearchDocumentPersistence>;
type DraftRestoration = ReturnType<typeof createResearchComposerDraftRestoration>;
type Draft = { nodeId: string; anchor: ResearchHighlightAnchor };

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

/** Persists the conversation composer's text per tree, and a new branch that
 * is still being written (the drawer's draft: its passage and text), so
 * leaving the research surface — which unmounts the document — loses
 * neither. A saved draft reopens in the drawer once its passage's turn has
 * loaded, unless the drawer is already showing something. Call after the
 * document's tree-reset effect so restoration wins over resets. */
export function useResearchComposerDrafts({
  persistence,
  treeId,
  mainText,
  draft,
  draftText,
  drawerOpen,
  chainNodeIds,
  contentByNode,
  setMainText,
  restoreDraft,
}: {
  persistence: Persistence;
  treeId: string | null;
  mainText: string;
  draft: Draft | null;
  draftText: string;
  drawerOpen: boolean;
  chainNodeIds: string[];
  contentByNode: Record<string, ResearchNodeContent>;
  setMainText: (text: string) => void;
  restoreDraft: (nodeId: string, anchor: ResearchHighlightAnchor, text: string) => void;
}) {
  const restoring = useRef<DraftRestoration | null>(null);
  if (!restoring.current) {
    restoring.current = createResearchComposerDraftRestoration(persistence.store);
  }
  const setMainTextRef = useRef(setMainText);
  setMainTextRef.current = setMainText;
  const restoreDraftRef = useRef(restoreDraft);
  restoreDraftRef.current = restoreDraft;
  const draftRestoredRef = useRef(false);

  useEffect(() => {
    setMainTextRef.current(restoring.current!.restore(treeId));
    draftRestoredRef.current = false;
  }, [persistence, treeId]);

  useEffect(() => {
    if (!treeId || draftRestoredRef.current || chainNodeIds.length === 0) return;
    if (drawerOpen) {
      draftRestoredRef.current = true;
      return;
    }
    const drafts = persistence.store[treeId]?.askByNode;
    for (const nodeId of chainNodeIds) {
      const saved = drafts?.[nodeId];
      if (!saved || !contentByNode[nodeId]?.responseRevision) continue;
      draftRestoredRef.current = true;
      restoreDraftRef.current(nodeId, saved.anchor, saved.text);
      return;
    }
  }, [chainNodeIds, contentByNode, drawerOpen, persistence, treeId]);

  useEffect(() => {
    if (!treeId) return;
    if (!restoring.current!.canPersist(treeId, mainText)) return;
    persistence.recordDraft(treeId, mainText);
  }, [mainText, persistence, treeId]);

  const draftContentLoaded = draft ? Boolean(contentByNode[draft.nodeId]) : false;
  useEffect(() => {
    // A tree reset commits asynchronously; an outgoing draft still present in
    // that render must not be written under the incoming tree.
    if (draft && treeId && draftContentLoaded && chainNodeIds.includes(draft.nodeId)) {
      persistence.recordAsk(treeId, draft.nodeId, draft.anchor, draftText);
    }
  }, [chainNodeIds, draft, draftContentLoaded, draftText, persistence, treeId]);
}
