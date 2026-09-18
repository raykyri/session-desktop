// Which answers have a background summary job in flight
// (`09-research-document-view.md` §2, `04-agent-runtime.md` §9).
//
// `research.recap.pending` is purely a viewer hint — the recap itself arrives
// as a node update — so it has no cache entry behind it. It lives in a store
// rather than in the query cache for the same reason `liveTurns` does: it
// changes several times per run and is read by exactly one subtree, and
// invalidating a list query for it would re-render the sidebar to move a
// spinner in a document.
//
// Nothing here is persisted: a job that was running when the tab closed is
// either finished or abandoned by the time it opens again, and either way the
// node update is what settles it.

import { create } from "zustand";

export interface RecapPendingState {
  /** Node ids whose summary is being generated. */
  nodeIds: ReadonlySet<string>;
  set: (nodeId: string, pending: boolean) => void;
  isPending: (nodeId: string) => boolean;
  clear: () => void;
}

export const useRecapPendingStore = create<RecapPendingState>()((set, get) => ({
  nodeIds: new Set<string>(),

  set: (nodeId, pending) =>
    set((state) => {
      if (state.nodeIds.has(nodeId) === pending) return state;
      const next = new Set(state.nodeIds);
      if (pending) next.add(nodeId);
      else next.delete(nodeId);
      return { nodeIds: next };
    }),

  isPending: (nodeId) => get().nodeIds.has(nodeId),
  clear: () => set({ nodeIds: new Set<string>() }),
}));
