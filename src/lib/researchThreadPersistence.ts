import {
  recordResearchFollowupDraft,
  recordResearchChainDraft,
  recordResearchScrollPosition,
  researchNavigationStore,
  saveResearchNavigation,
} from "./researchNavigation";
import type { ResearchHighlightAnchor } from "../types";
import type { ResearchScrollKind } from "@session/shared/lib/researchColumns";

interface SubmittedDraft { treeId: string; headId: string; text: string; imageIds: readonly string[] }
const submittedDraftListeners = new Set<(draft: SubmittedDraft) => void>();

/** A send can finish after its thread page remounts; clear matching text
 * in the currently mounted composer as well as in durable storage. */
export function subscribeResearchDraftSubmitted(listener: (draft: SubmittedDraft) => void): () => void {
  submittedDraftListeners.add(listener);
  return () => { submittedDraftListeners.delete(listener); };
}

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
export function createResearchThreadPersistence(
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
    recordScroll(treeId: string, nodeId: string, top: number, column: ResearchScrollKind = "answer") {
      recordResearchScrollPosition(entry(treeId), nodeId, top, Date.now(), column);
      schedule();
    },
    recordDraft(treeId: string, text: string) {
      if (recordResearchFollowupDraft(entry(treeId), text)) schedule();
    },
    recordChainDraft(treeId: string, headId: string, text: string) {
      if (recordResearchChainDraft(entry(treeId), headId, text)) schedule();
    },
    clearSubmittedDraft(treeId: string, headId: string, text: string, root: boolean, imageIds: readonly string[] = []) {
      const navigation = store[treeId];
      let changed = false;
      const saved = root ? navigation?.followupDraft?.text : navigation?.chainDrafts?.[headId];
      if (navigation && saved === text) {
        if (root) recordResearchFollowupDraft(navigation, "");
        else recordResearchChainDraft(navigation, headId, "");
        delete navigation.composerEditingByHead?.[headId];
        changed = true;
      }
      const savedImages = navigation?.composerImages;
      const previousImages = savedImages?.images[headId] ?? [];
      const remaining = previousImages.filter((image) => !imageIds.includes(image.id));
      if (savedImages && remaining.length !== previousImages.length) {
        const images = { ...savedImages.images };
        if (remaining.length) images[headId] = remaining;
        else delete images[headId];
        if (Object.keys(images).length) navigation.composerImages = { images, updatedAt: Date.now() };
        else delete navigation.composerImages;
        changed = true;
      }
      if (changed) flush();
      for (const listener of submittedDraftListeners) listener({ treeId, headId, text, imageIds });
    },
    recordComposerEditing(treeId: string, editing: Record<string, string>) {
      const navigation = entry(treeId);
      if (JSON.stringify(navigation.composerEditingByHead ?? {}) === JSON.stringify(editing)) return;
      if (Object.keys(editing).length) navigation.composerEditingByHead = { ...editing };
      else delete navigation.composerEditingByHead;
      schedule();
    },
    recordPendingBranch(
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
    clearPendingBranch(treeId: string, nodeId: string) {
      const branches = store[treeId]?.askByNode;
      if (branches?.[nodeId]) {
        delete branches[nodeId];
        flush();
      }
    },
  };
}
