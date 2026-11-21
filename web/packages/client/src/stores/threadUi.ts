// Per-thread UI state (02 §9.4 `threadUi`, in memory): the selected branch
// or reply, the one open inline composer of the thread, and the collapsed
// replies. Opening a composer on a thread closes any other composer on it
// (the one-composer rule, W9.3); a selection closes the composer, as the
// mock's `tsel` and `rsel` do.

import { create } from "zustand";

/** A passage quoted by Branch here: its text, its passage index, and
 * whether the whole quote is shown. */
export interface Quote {
  text: string;
  b: number | null;
  open: boolean;
}

export type InlineComposer =
  /** An ask under `parent` ("r" or a node): the footer's follow-up, Branch
   * here (with `quote`), Continue and Branch. */
  | { kind: "ask"; parent: string; quote?: Quote | undefined }
  /** A comment on `node`, at its top or under the comment `parent`. */
  | { kind: "comment"; node: string; parent: string | null }
  /** A reply to a post, at its root or to the reply `parent`. */
  | { kind: "reply"; parent: string | null };

export interface ThreadUiEntry {
  selected: string | null;
  composer: InlineComposer | null;
  collapsed: readonly string[];
}

const EMPTY: ThreadUiEntry = { selected: null, composer: null, collapsed: [] };

interface ThreadUiState {
  byThread: Record<string, ThreadUiEntry>;
  /** Selects a row, or clears the selection; closes the thread's composer. */
  select: (thread: string, id: string | null) => void;
  /** Selects `id` unless it is selected, else clears it. */
  toggle: (thread: string, id: string) => void;
  open: (thread: string, composer: InlineComposer, selected?: string | null) => void;
  close: (thread: string) => void;
  toggleCollapsed: (thread: string, reply: string) => void;
  reset: () => void;
}

export const useThreadUiStore = create<ThreadUiState>()((set) => {
  const update = (thread: string, change: (entry: ThreadUiEntry) => ThreadUiEntry) =>
    set((state) => ({
      byThread: { ...state.byThread, [thread]: change(state.byThread[thread] ?? EMPTY) },
    }));
  return {
    byThread: {},
    select: (thread, id) => update(thread, (e) => ({ ...e, selected: id, composer: null })),
    toggle: (thread, id) =>
      update(thread, (e) => ({ ...e, selected: e.selected === id ? null : id, composer: null })),
    open: (thread, composer, selected) =>
      update(thread, (e) => ({
        ...e,
        composer,
        selected: selected === undefined ? e.selected : selected,
      })),
    close: (thread) => update(thread, (e) => ({ ...e, composer: null })),
    toggleCollapsed: (thread, reply) =>
      update(thread, (e) => ({
        ...e,
        collapsed: e.collapsed.includes(reply)
          ? e.collapsed.filter((x) => x !== reply)
          : [...e.collapsed, reply],
      })),
    reset: () => set({ byThread: {} }),
  };
});

export function useThreadUi(thread: string): ThreadUiEntry {
  return useThreadUiStore((state) => state.byThread[thread] ?? EMPTY);
}

/** The key of a composer, for its draft (02 §9.4 `drafts`). */
export function composerKey(thread: string, c: InlineComposer): string {
  switch (c.kind) {
    case "ask":
      return `ask:${thread}:${c.parent}`;
    case "comment":
      return `comment:${thread}:${c.node}:${c.parent ?? "top"}`;
    case "reply":
      return `reply:${thread}:${c.parent ?? "top"}`;
  }
}
