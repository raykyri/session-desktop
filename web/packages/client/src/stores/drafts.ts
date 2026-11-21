// Composer drafts (02 §9.4): the unsent text of each composer, kept in this
// tab's sessionStorage so a reload, an `UPGRADE_REQUIRED` reload or a
// discarded write leaves the text in its composer. Drafts belong to one
// account: `claimDrafts` drops another account's drafts, `hideDrafts` keeps
// them unreadable while no session is known, and sign-out clears them.
//
// The text of a write that is "Not sent" is kept here too (`unsent`, by the
// write's local id, with its composer's key) until the write is applied or
// discarded: a reload drops unsent writes (02 §9.2), and the next load puts
// that text back in its composer when the composer is empty.
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

/** The text of a "Not sent" write and the composer it came from. */
export interface UnsentDraft {
  key: string;
  text: string;
}

export interface DraftsState {
  byKey: Record<string, ComposerDraft>;
  /** The text of each "Not sent" write, by the write's local id. */
  unsent: Record<string, UnsentDraft>;
  /** The account the stored drafts belong to; null signed out, undefined
   * before the session is known. */
  owner?: string | null | undefined;
  /** True while no session is known: reads answer nothing, writes are
   * ignored. Not persisted. */
  hidden?: boolean | undefined;
  get: (key: string) => ComposerDraft | undefined;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
  /** Keep a "Not sent" write's text for a reload. */
  keepUnsent: (local: string, draft: UnsentDraft) => void;
  /** The write was applied, refused or discarded. */
  dropUnsent: (local: string) => void;
}

type Persisted = Pick<DraftsState, "byKey" | "owner"> & { unsent?: Record<string, UnsentDraft> };

/** A load of the tab: the text of the writes that were "Not sent" when the
 * page went away goes back to their composers, unless a composer holds
 * other text. */
export function restoreUnsent(state: Persisted): Persisted {
  const byKey = { ...state.byKey };
  for (const { key, text } of Object.values(state.unsent ?? {}))
    if (!byKey[key]?.text.trim()) byKey[key] = { text, updatedAt: Date.now() };
  return { byKey, owner: state.owner, unsent: {} };
}

export const useDraftsStore = create<DraftsState>()(
  persist(
    (set, get) => ({
      byKey: {},
      unsent: {},
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
      keepUnsent: (local, draft) => {
        if (get().hidden) return;
        set((state) => ({ unsent: { ...state.unsent, [local]: draft } }));
      },
      dropUnsent: (local) => {
        set((state) => {
          if (!(local in state.unsent)) return state;
          const next = { ...state.unsent };
          delete next[local];
          return { unsent: next };
        });
      },
    }),
    {
      name: DRAFTS_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state): Persisted => ({
        byKey: state.byKey,
        owner: state.owner,
        unsent: state.unsent,
      }),
      merge: (persisted, current) => {
        const p = persisted as Persisted | undefined;
        if (!p || typeof p !== "object" || typeof p.byKey !== "object") return current;
        return { ...current, ...restoreUnsent(p) };
      },
    },
  ),
);

/** Drops every draft and records `owner` as the account they belong to. */
export function resetDrafts(owner: string | null | undefined): void {
  useDraftsStore.setState({ byKey: {}, unsent: {}, owner, hidden: false });
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
