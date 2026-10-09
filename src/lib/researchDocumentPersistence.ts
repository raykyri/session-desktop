import {
  recordResearchFollowupDraft,
  recordResearchScrollPosition,
  researchNavigationStore,
  saveResearchNavigation,
} from "./researchNavigation";
import type { QueuedResearchFollowup } from "./researchNavigation";
import type { ResearchHighlightAnchor } from "../types";

/** Prevent transitional React state from overwriting the destination tree's draft. */
export function createResearchComposerDraftRestoration(
  store = researchNavigationStore(),
) {
  let expected: { treeId: string; text: string } | null = null;
  return {
    restore(treeId: string | null) {
      const text = (treeId ? store[treeId]?.followupDraft?.text : undefined) ?? "";
      expected = treeId ? { treeId, text } : null;
      return text;
    },
    canPersist(treeId: string, text: string) {
      if (expected?.treeId === treeId) {
        if (text !== expected.text) return false;
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
    recordDraft(treeId: string, text: string) {
      if (recordResearchFollowupDraft(entry(treeId), text)) schedule();
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
    recordPinned(treeId: string, headIds: string[]) {
      const navigation = entry(treeId);
      if (headIds.length === 0) {
        if (!navigation.pinnedBranches) return;
        delete navigation.pinnedBranches;
      } else {
        navigation.pinnedBranches = [...headIds];
      }
      flush();
    },
    recordQueue(treeId: string, headId: string, queue: QueuedResearchFollowup[]) {
      const navigation = entry(treeId);
      if (queue.length === 0) {
        if (!navigation.queuedFollowups?.[headId]) return;
        delete navigation.queuedFollowups[headId];
      } else {
        (navigation.queuedFollowups ??= {})[headId] = queue;
      }
      flush();
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
