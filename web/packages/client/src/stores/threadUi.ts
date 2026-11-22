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
   * here (with `quote`), Continue and Branch. `from` is the row it was
   * opened from, which stays selected while it is open: null for the
   * footer's follow-up and Branch here, the branch itself for Continue and
   * Branch. */
  | { kind: "ask"; parent: string; from: string | null; quote?: Quote | undefined }
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

/** The inline composer a draft key names (`composerKey`), with the row it
 * shows under; null for any other key (the new-thread composer's). An ask's
 * quote is not in its key: Branch here comes back as the follow-up composer
 * at the answer. */
export function composerOfKey(
  key: string,
): { thread: string; composer: InlineComposer; selected: string | null } | null {
  const [kind, thread, a, b, extra] = key.split(":");
  if (!thread || extra !== undefined) return null;
  if (kind === "ask" && a && b) {
    const from = b === "top" ? null : b;
    return { thread, composer: { kind: "ask", parent: a, from }, selected: from };
  }
  if (kind === "reply" && a && b === undefined) {
    const parent = a === "top" ? null : a;
    return { thread, composer: { kind: "reply", parent }, selected: parent };
  }
  if (kind === "comment" && a && b)
    return {
      thread,
      composer: { kind: "comment", node: a, parent: b === "top" ? null : b },
      selected: a,
    };
  return null;
}

/** The key of a composer, for its draft (02 §9.4 `drafts`). It names where
 * the composer shows, so Discard can open it there again
 * (`composerOfKey`). */
export function composerKey(thread: string, c: InlineComposer): string {
  switch (c.kind) {
    case "ask":
      return `ask:${thread}:${c.parent}:${c.from ?? "top"}`;
    case "comment":
      return `comment:${thread}:${c.node}:${c.parent ?? "top"}`;
    case "reply":
      return `reply:${thread}:${c.parent ?? "top"}`;
  }
}
