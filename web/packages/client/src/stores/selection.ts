// Research multi-select (07 §4.3): the ids the sidebar and document surfaces
// act on together (archive, move to folder, delete). Not persisted — a
// selection that outlived a reload would act on rows the user can no longer
// see.

import { create } from "zustand";

export interface SelectionState {
  ids: string[];
  /** The row a shift-click range extends from. */
  anchorId: string | null;
  isSelected: (id: string) => boolean;
  select: (id: string) => void;
  toggle: (id: string) => void;
  selectRange: (orderedIds: string[], toId: string) => void;
  setSelection: (ids: string[]) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  ids: [],
  anchorId: null,

  isSelected: (id) => get().ids.includes(id),
  select: (id) => set({ ids: [id], anchorId: id }),
  toggle: (id) =>
    set((state) => {
      const selected = state.ids.includes(id);
      return {
        ids: selected ? state.ids.filter((candidate) => candidate !== id) : [...state.ids, id],
        anchorId: selected ? state.anchorId : id,
      };
    }),
  // Shift-click: extend from the anchor to `toId` in the list's own order, so
  // the range follows what the user sees rather than selection order.
  selectRange: (orderedIds, toId) =>
    set((state) => {
      const anchor = state.anchorId ?? toId;
      const from = orderedIds.indexOf(anchor);
      const to = orderedIds.indexOf(toId);
      if (from === -1 || to === -1) return { ids: [toId], anchorId: toId };
      const [start, end] = from <= to ? [from, to] : [to, from];
      return { ids: orderedIds.slice(start, end + 1), anchorId: anchor };
    }),
  setSelection: (ids) => set({ ids, anchorId: ids[ids.length - 1] ?? null }),
  clear: () => set({ ids: [], anchorId: null }),
}));
