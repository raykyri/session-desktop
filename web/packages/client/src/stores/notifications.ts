// Toasts. Client code pushes them through `lib/toast.ts`; the server emits no
// notification events yet (`03-api-and-events.md` §3). `NotificationStack`
// renders at most the first three and the list is capped at twenty so a burst
// cannot grow without bound.

import { create } from "zustand";

export type NotificationTone = "info" | "success" | "warning" | "error";

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  tone: NotificationTone;
  /** How long the toast stays before dismissing itself, clamped on push. */
  timeoutMs: number;
  createdAt: number;
  /** Route to open when the toast is activated, if the server named one. */
  href?: string | undefined;
  /** A button beside the text, such as Undo after a move. */
  action?: { label: string; run: () => void } | undefined;
}

export const MAX_NOTIFICATIONS = 20;
export const MAX_VISIBLE_NOTIFICATIONS = 3;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

export interface NotificationsState {
  items: NotificationItem[];
  /** Re-pushing an id replaces the existing toast and moves it to the end, so
   * a repeated status update does not stack up copies of itself. */
  push: (item: NotificationItem) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useNotificationsStore = create<NotificationsState>()((set) => ({
  items: [],
  push: (item) =>
    set((state) => ({
      items: [
        ...state.items.filter((existing) => existing.id !== item.id),
        {
          ...item,
          timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, item.timeoutMs)),
        },
      ].slice(-MAX_NOTIFICATIONS),
    })),
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clear: () => set({ items: [] }),
}));
