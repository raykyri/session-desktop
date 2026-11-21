// Bringing a thread into view (02 §2.1, W2.6; the mock's `promote`,
// `gothread`): the thread address of a route and a thread opened from a
// branch both ask the feed to scroll a thread's card 12 px below the top of
// the feed, select an item in it and flash the card. The feed (`FeedPage`)
// does it once the row is in the list, scrolling a virtualised list to the
// row first.

import { create } from "zustand";

export interface Reveal {
  thread: string;
  /** The branch or reply to select. */
  sel?: string | undefined;
  /** Bumped on each request, so the same thread can be revealed again. */
  n: number;
}

interface RevealState {
  reveal: Reveal | null;
  request: (thread: string, sel?: string) => void;
  done: (n: number) => void;
}

let counter = 0;

export const useRevealStore = create<RevealState>()((set, get) => ({
  reveal: null,
  request: (thread, sel) => {
    counter += 1;
    set({ reveal: { thread, sel, n: counter } });
  },
  done: (n) => {
    if (get().reveal?.n === n) set({ reveal: null });
  },
}));

export function revealThread(thread: string, sel?: string): void {
  useRevealStore.getState().request(thread, sel);
}

/** How long a revealed card keeps its ring (`.card.flash`). */
export const FLASH_MS = 1600;
