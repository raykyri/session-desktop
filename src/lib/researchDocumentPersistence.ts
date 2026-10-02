import {
  recordResearchFollowupDraft,
  recordResearchScrollPosition,
  researchNavigationStore,
  saveResearchNavigation,
} from "./researchNavigation";
import type { ResearchHighlightAnchor } from "../types";

/** Prevent transitional React state from overwriting the destination tree's draft. */
export function createResearchComposerDraftRestoration(
  store = researchNavigationStore(),
) {
  let expected: {
    treeId: string;
    text: string;
    mode: "thread" | "branch";
  } | null = null;
  return {
    restore(treeId: string | null) {
      const saved = treeId ? store[treeId]?.followupDraft : undefined;
      const draft = { text: saved?.text ?? "", mode: saved?.mode ?? "thread" };
      expected = treeId ? { treeId, ...draft } : null;
      return draft;
    },
    finish() {
      expected = null;
    },
    canPersist(treeId: string, text: string, mode: "thread" | "branch") {
      if (expected?.treeId === treeId) {
        if (text !== expected.text || mode !== expected.mode) return false;
        expected = null;
      }
      return true;
    },
  };
}

/** Immediate store mutations share one durable-write debounce and final flush. */
export function createResearchDocumentPersistence(
  store = researchNavigationStore(),
  save: () => void = saveResearchNavigation,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancelPending = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    cancelPending();
    save();
  };
  const schedule = () => {
    cancelPending();
    timer = setTimeout(() => {
      timer = null;
      save();
    }, 250);
  };
  const entry = (treeId: string) => (store[treeId] ??= { scrollByNode: {} });
  return {
    store,
    flush,
    recordScroll(treeId: string, nodeId: string, top: number) {
      recordResearchScrollPosition(entry(treeId), nodeId, top);
      schedule();
    },
    recordDraft(treeId: string, text: string, mode: "thread" | "branch") {
      if (recordResearchFollowupDraft(entry(treeId), text, mode)) schedule();
    },
    recordAsk(
      treeId: string,
      nodeId: string,
      anchor: ResearchHighlightAnchor,
      text: string,
    ) {
      (entry(treeId).askByNode ??= {})[nodeId] = {
        anchor,
        text,
        updatedAt: Date.now(),
      };
      schedule();
    },
    clearAsk(treeId: string, nodeId: string) {
      const asks = store[treeId]?.askByNode;
      if (asks?.[nodeId]) {
        delete asks[nodeId];
        flush();
      }
    },
  };
}
