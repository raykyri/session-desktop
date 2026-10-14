// A request for the Home ask box to take focus (Shift-Cmd-H, the desktop's
// Home chord). The shell sets it before it navigates Home; the ask box takes
// it when it is mounted (or at once when it already is) and clears it.

import { create } from "zustand";

interface HomeFocusState {
  /** Increments with each request; 0 when none is pending. */
  request: number;
  clear: () => void;
}

export const useHomeFocusStore = create<HomeFocusState>()((set) => ({
  request: 0,
  clear: () => set({ request: 0 }),
}));

export function requestHomeComposerFocus(): void {
  useHomeFocusStore.setState((state) => ({ request: state.request + 1 }));
}
