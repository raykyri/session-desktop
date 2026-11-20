// Page chrome state that is not in the URL (02 §9.4), kept in localStorage:
// the app bar's channel scope, the applied feed layout and the last channel
// opened.
//
// The layout's source of truth is the `prefs` record in the user log
// (01 C13, written with `prefs.set`); this store holds the applied value so
// the first paint does not wait for the replica (ADR-20, 02 §3.1). Until the
// replica lands, the layout toggle writes here only.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const NAVIGATION_STORAGE_KEY = "session.navigation.v3";

/** Which channels the app bar's strip lists (02 §2.2 item 2, `SCOPES`). */
export type ChannelScope = "joined" | "yours" | "all";

/** `centred` is the mock's layout A, `wide` its layout B (02 §3.1). */
export type FeedLayout = "centred" | "wide";

export interface NavigationState {
  scope: ChannelScope;
  layout: FeedLayout;
  /** Name of the channel feed opened last, without `#`. */
  lastChannel: string | null;
  setScope: (scope: ChannelScope) => void;
  setLayout: (layout: FeedLayout) => void;
  toggleLayout: () => void;
  setLastChannel: (name: string | null) => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set) => ({
      scope: "joined",
      layout: "centred",
      lastChannel: null,
      setScope: (scope) => set({ scope }),
      setLayout: (layout) => set({ layout }),
      toggleLayout: () =>
        set((state) => ({ layout: state.layout === "centred" ? "wide" : "centred" })),
      setLastChannel: (lastChannel) => set({ lastChannel }),
    }),
    {
      name: NAVIGATION_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        scope: state.scope,
        layout: state.layout,
        lastChannel: state.lastChannel,
      }),
    },
  ),
);
