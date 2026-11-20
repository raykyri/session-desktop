// Composer drafts (02 §9.4): the unsent text of each composer, kept in this
// tab's sessionStorage so a reload, an `UPGRADE_REQUIRED` reload or a
// discarded write leaves the text in its composer. Drafts belong to one
// account: `claimDrafts` drops another account's drafts, `hideDrafts` keeps
// them unreadable while no session is known, and sign-out clears them.
//
// The composers that read and write this store are built with W5.1; the
// research client's server-side draft sync (`interfaceDrafts`) is gone.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const DRAFTS_STORAGE_KEY = "session.drafts.v3";

export interface ComposerDraft {
  text: string;
  updatedAt: number;
}

export interface DraftsState {
  byKey: Record<string, ComposerDraft>;
  /** The account the stored drafts belong to; null signed out, undefined
   * before the session is known. */
  owner?: string | null | undefined;
  /** True while no session is known: reads answer nothing, writes are
   * ignored. Not persisted. */
  hidden?: boolean | undefined;
  get: (key: string) => ComposerDraft | undefined;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
}

export const useDraftsStore = create<DraftsState>()(
  persist(
    (set, get) => ({
      byKey: {},
      get: (key) => (get().hidden ? undefined : get().byKey[key]),
      setDraft: (key, text) => {
        if (get().hidden) return;
        set((state) => ({ byKey: { ...state.byKey, [key]: { text, updatedAt: Date.now() } } }));
      },
      clearDraft: (key) => {
        if (get().hidden) return;
        set((state) => {
          if (!(key in state.byKey)) return state;
          const next = { ...state.byKey };
          delete next[key];
          return { byKey: next };
        });
      },
    }),
    {
      name: DRAFTS_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ byKey: state.byKey, owner: state.owner }),
    },
  ),
);

/** Drops every draft and records `owner` as the account they belong to. */
export function resetDrafts(owner: string | null | undefined): void {
  useDraftsStore.setState({ byKey: {}, owner, hidden: false });
}

/** Makes the stored drafts readable for `owner`, or drops them when they
 * belong to another account. */
export function claimDrafts(owner: string | null): void {
  const state = useDraftsStore.getState();
  if (state.owner === owner) {
    if (state.hidden) useDraftsStore.setState({ hidden: false });
    return;
  }
  resetDrafts(owner);
}

/** Keeps the stored drafts but makes them unreadable until an account claims
 * them (a signed-out tab, or a session that expired). */
export function hideDrafts(): void {
  useDraftsStore.setState({ hidden: true });
}
