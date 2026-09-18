import { useNotificationsStore, type NotificationItem } from "../stores/notifications.js";

export interface UserNotificationsApi {
  notifications: NotificationItem[];
  dismiss: (id: string) => void;
  clear: () => void;
}

/**
 * The hook `AppShell` uses to bind the notification store to the toast region,
 * ported from the desktop `hooks/useUserNotifications.ts`.
 *
 * The desktop hook owned the list in `useState` and decided on arrival whether
 * a toast was wanted. Here the list lives in the store so the SSE bridge can
 * push to it without a React tree, the bridge enforces the `showNotifications`
 * preference at the one ingress (`api/events.ts`), and the hook is only the
 * read side.
 */
export function useUserNotifications(): UserNotificationsApi {
  const notifications = useNotificationsStore((state) => state.items);
  const dismiss = useNotificationsStore((state) => state.dismiss);
  const clear = useNotificationsStore((state) => state.clear);

  return { notifications, dismiss, clear };
}
