// Client-originated toasts (`10-home-feed-journal.md` §8): a copy confirmation
// or a failed action. They are pushed to the notifications store past the
// `showNotifications` preference check. The server emits no toasts yet.

import { useNotificationsStore, type NotificationTone } from "../stores/notifications.js";
import { useSettingsStore } from "../stores/settings.js";

/** How long a client toast stays. Short: these confirm an action the user just
 * took, and the action itself is the evidence. */
export const CLIENT_TOAST_TIMEOUT_MS = 4_000;

let counter = 0;

export interface ClientToast {
  title: string;
  body?: string;
  tone?: NotificationTone;
  /** Re-pushing the same id replaces the visible toast rather than stacking a
   * second copy of it (`stores/notifications.ts`). */
  id?: string;
  /** Undo after a move or a move to the Trash. A toast with an action is
   * shown even with notifications turned off, since it is the only way to
   * take the action back, and it stays longer. */
  undo?: () => void;
}

/** How long a toast with Undo stays (the desktop's toast keeps its Undo for
 * about as long). */
export const UNDO_TOAST_TIMEOUT_MS = 8_000;

export function pushToast(toast: ClientToast): void {
  if (!toast.undo && !useSettingsStore.getState().settings.showNotifications) return;
  counter += 1;
  useNotificationsStore.getState().push({
    id: toast.id ?? `client:${counter}`,
    title: toast.title,
    body: toast.body ?? "",
    tone: toast.tone ?? "info",
    timeoutMs: toast.undo ? UNDO_TOAST_TIMEOUT_MS : CLIENT_TOAST_TIMEOUT_MS,
    createdAt: Date.now(),
    ...(toast.undo ? { action: { label: "Undo", run: toast.undo } } : {}),
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shape every failed action in a feature uses, so one refusal reads the
 * same wherever it happened. */
export function pushErrorToast(title: string, error: unknown): void {
  pushToast({ title, body: errorMessage(error), tone: "error" });
}
