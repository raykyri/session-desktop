import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn.js";
import {
  MAX_VISIBLE_NOTIFICATIONS,
  type NotificationItem,
  type NotificationTone,
} from "../stores/notifications.js";

import { IconButton } from "./Button.js";

const EXIT_MS = 180;

const TONE_BORDER: Record<NotificationTone, string> = {
  info: "border-status-info-border",
  success: "border-toast-success-border",
  warning: "border-toast-warning-border",
  error: "border-toast-error-border",
};

const TONE_ICON_COLOR: Record<NotificationTone, string> = {
  info: "text-status-info",
  success: "text-toast-success",
  warning: "text-toast-warning",
  error: "text-toast-error",
};

function ToneIcon({ tone }: { tone: NotificationTone }) {
  const props = { size: 18, "aria-hidden": true as const };
  switch (tone) {
    case "success":
      return <CheckCircle2 {...props} />;
    case "warning":
      return <TriangleAlert {...props} />;
    case "error":
      return <CircleAlert {...props} />;
    default:
      return <Info {...props} />;
  }
}

function NotificationCard({
  notification,
  active,
  onDismiss,
  onOpen,
}: {
  notification: NotificationItem;
  active: boolean;
  onDismiss: (id: string) => void;
  onOpen?: ((href: string) => void) | undefined;
}) {
  const [phase, setPhase] = useState<"entering" | "visible" | "exiting">("entering");
  const [hovered, setHovered] = useState(false);
  const remainingRef = useRef(notification.timeoutMs);
  const dismissingRef = useRef(false);
  const exitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPhase("visible"));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  const beginDismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    setPhase("exiting");
    exitTimerRef.current = window.setTimeout(() => onDismiss(notification.id), EXIT_MS);
  }, [notification.id, onDismiss]);

  // The countdown pauses while the tab is in the background or the pointer is
  // over the card, and resumes with the time that was left — a toast that
  // expired unseen would be no notification at all.
  useEffect(() => {
    if (!active || hovered || phase !== "visible") return;
    const startedAt = performance.now();
    const timer = window.setTimeout(beginDismiss, Math.max(0, remainingRef.current));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - startedAt));
    };
  }, [active, beginDismiss, hovered, phase]);

  const content = (
    <>
      <span className={cn("flex shrink-0 items-center", TONE_ICON_COLOR[notification.tone])}>
        <ToneIcon tone={notification.tone} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-fg-strong min-w-0 truncate text-base font-semibold">
          {notification.title}
        </strong>
        {notification.body ? (
          <span className="text-fg-secondary text-sm">{notification.body}</span>
        ) : null}
      </span>
    </>
  );

  return (
    <article
      className={cn(
        "session-notification pointer-events-auto flex w-80 items-center gap-1 rounded-lg border",
        "bg-surface-popover shadow-popover p-3 transition-[opacity,translate] duration-[180ms]",
        TONE_BORDER[notification.tone],
        phase === "visible" ? "translate-x-0 opacity-100" : "translate-x-2 opacity-0",
      )}
      role="status"
      aria-live={notification.tone === "error" ? "assertive" : "polite"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {notification.href && onOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
          aria-label={`${notification.title}: ${notification.body}. Open.`}
          onClick={() => {
            onOpen(notification.href!);
            beginDismiss();
          }}
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{content}</div>
      )}
      <IconButton label="Dismiss notification" onClick={beginDismiss}>
        <X size={15} aria-hidden="true" />
      </IconButton>
    </article>
  );
}

export interface NotificationStackProps {
  notifications: readonly NotificationItem[];
  onDismiss: (id: string) => void;
  onOpen?: ((href: string) => void) | undefined;
}

/**
 * The toast region, ported from the desktop `UserNotificationStack.tsx`. At
 * most three cards are on screen at once; the rest wait in the store.
 */
export function NotificationStack({ notifications, onDismiss, onOpen }: NotificationStackProps) {
  const [windowActive, setWindowActive] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  const visible = notifications.slice(0, MAX_VISIBLE_NOTIFICATIONS);

  useEffect(() => {
    const update = () =>
      setWindowActive(document.visibilityState === "visible" && document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  if (visible.length === 0) return null;
  return (
    // A bare `aria-label` on a roleless element is dropped; the landmark is
    // what gives the label somewhere to live and the stack a name to jump to.
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed top-4 right-4 z-(--z-toast) flex flex-col gap-2"
    >
      {visible.map((notification) => (
        <NotificationCard
          key={notification.id}
          notification={notification}
          active={windowActive}
          onDismiss={onDismiss}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
