// The Escape stack (07 §4.4). Base UI dismisses its own dialogs, menus and
// popovers with correct nesting, so only the layers it does not own register
// here: the DOM search bar today, the selection popover and sidebar
// multi-select with Phase 6. `AppShell` installs one capture-phase keydown
// listener and gives Escape to the top entry, which replaces the desktop's
// hand-ordered dispatcher (`App.tsx:9094-9220`). Base UI layers handle Escape
// directly while open, bypassing this stack.
//
// "Top" is the highest priority, and among equal priorities the most recently
// registered — so two layers in one band unwind in open order, while a layer
// opened underneath an existing one still wins if its priority says so.

import { create } from "zustand";

/** Higher runs first. The numbers are sparse so a new layer can be slotted
 * between two existing ones without renumbering.
 *
 * Only layers Base UI does not own appear here, and only once something
 * registers them. The command palette and both lightboxes are Base UI dialogs
 * and dismiss themselves, so they have no entry; the selection popover and
 * sidebar multi-select join when Phase 6 builds them. */
export const OVERLAY_PRIORITY = {
  searchBar: 200,
  /** Below the search bar: a find-in-page opened over the preview is the
   * transient layer, and Escape belongs to it first
   * (`11-artifacts-and-browser.md` §3). */
  artifactPanel: 100,
} as const;

export interface OverlayEntry {
  id: string;
  priority: number;
  onEscape: () => void;
  /** Monotonic registration counter; breaks priority ties in favor of the
   * layer opened last. */
  sequence: number;
}

export interface OverlaysState {
  entries: OverlayEntry[];
  register: (id: string, priority: number, onEscape: () => void) => void;
  unregister: (id: string) => void;
  /** The entry Escape belongs to, or null when nothing is registered. */
  top: () => OverlayEntry | null;
  /** Dismisses the top layer. Returns true when a layer handled the key, which
   * is what tells the shell to stop the event. */
  dismissTop: () => boolean;
  clear: () => void;
}

let sequenceCounter = 0;

function compare(a: OverlayEntry, b: OverlayEntry): number {
  return a.priority === b.priority ? b.sequence - a.sequence : b.priority - a.priority;
}

export const useOverlaysStore = create<OverlaysState>()((set, get) => ({
  entries: [],

  register: (id, priority, onEscape) =>
    set((state) => {
      sequenceCounter += 1;
      const entry: OverlayEntry = { id, priority, onEscape, sequence: sequenceCounter };
      // Re-registering an id replaces it (a re-render with a new callback)
      // without moving it up the stack.
      const existing = state.entries.find((candidate) => candidate.id === id);
      if (existing) {
        entry.sequence = existing.sequence;
        return {
          entries: state.entries
            .map((candidate) => (candidate.id === id ? entry : candidate))
            .sort(compare),
        };
      }
      return { entries: [...state.entries, entry].sort(compare) };
    }),

  unregister: (id) =>
    set((state) => {
      const entries = state.entries.filter((entry) => entry.id !== id);
      return entries.length === state.entries.length ? state : { entries };
    }),

  top: () => get().entries[0] ?? null,

  dismissTop: () => {
    const entry = get().entries[0];
    if (!entry) return false;
    entry.onEscape();
    return true;
  },

  clear: () => set({ entries: [] }),
}));
