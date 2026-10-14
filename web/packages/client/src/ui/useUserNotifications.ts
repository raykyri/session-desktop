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
 * a toast was requested. Here the list is stored so code outside a React tree
 * can push to it, `api/events.ts` applies the `showNotifications` preference to
 * server notifications,
 * and the hook is only the read side.
 */
export function useUserNotifications(): UserNotificationsApi {
  const notifications = useNotificationsStore((state) => state.items);
  const dismiss = useNotificationsStore((state) => state.dismiss);
  const clear = useNotificationsStore((state) => state.clear);

  return { notifications, dismiss, clear };
}
