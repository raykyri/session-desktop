import { useCallback, useRef, useState } from "react";
import type { UserNotificationItem, UserNotificationTone } from "../components/UserNotificationStack";
import { playCompletionSound } from "../lib/api";
import type { AppSettings } from "../lib/settings";
import type { QmuxEvent } from "../types";

interface UserNotificationOptions {
  settings: Pick<AppSettings, "showNotifications" | "completionSound">;
  onOpenPane: (paneId: string) => void;
}

/** Owns transient notification state and stable callbacks for the event subscription. */
export function useUserNotifications(options: UserNotificationOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [userNotifications, setUserNotifications] = useState<UserNotificationItem[]>([]);

  const handleUserNotificationRequested = useCallback((event: QmuxEvent) => {
    const { id, title, body, tone, timeoutMs, sound, createdAt } = event.payload;
    if (
      typeof id !== "string" ||
      typeof title !== "string" ||
      typeof body !== "string" ||
      typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs)
    ) {
      return;
    }
    if (!optionsRef.current.settings.showNotifications) {
      return;
    }
    const normalizedTone: UserNotificationTone =
      tone === "success" || tone === "warning" || tone === "error" ? tone : "info";
    setUserNotifications((current) =>
      [
        ...current.filter((notification) => notification.id !== id),
        {
          id,
          title,
          body,
          tone: normalizedTone,
          timeoutMs: Math.min(30_000, Math.max(1_000, timeoutMs)),
          paneId: event.paneId ?? null,
          createdAt:
            typeof createdAt === "number" && Number.isFinite(createdAt)
              ? createdAt
              : Date.now(),
        },
      ].slice(-20),
    );
    if (sound === true) {
      void playCompletionSound(optionsRef.current.settings.completionSound).catch(() => undefined);
    }
  }, []);

  const handleNotificationOpenPane = useCallback(
    (paneId: string) => optionsRef.current.onOpenPane(paneId),
    [],
  );
  const dismissUserNotification = useCallback((id: string) => {
    setUserNotifications((current) =>
      current.filter((notification) => notification.id !== id),
    );
  }, []);

  return {
    userNotifications,
    handleUserNotificationRequested,
    handleNotificationOpenPane,
    dismissUserNotification,
  };
}
