// The notification inbox (web only; `10-home-feed-journal.md` §4c): the
// server's notifications to the reader, newest first — a run they asked
// finishing, a new question or note in a thread they follow, a branch from
// their answer, an invitation. Opening one marks it read and goes to its
// link; Mark all as read clears the count. The Notifications setting governs
// only the toasts; everything is listed here.

import type { InboxNotification } from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { useMemo } from "react";

import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationInbox,
  useUnreadNotificationCount,
} from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { formatRelativeTime } from "../../lib/relativeTime.js";
import { pushErrorToast } from "../../lib/toast.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

/** Only an in-app path is followed. */
function safeHref(href: string | null): string | null {
  return href !== null && href.startsWith("/") && !href.startsWith("//") ? href : null;
}

export function NotificationInbox() {
  const navigate = useNavigate();
  const inbox = useNotificationInbox();
  const unread = useUnreadNotificationCount().data ?? 0;
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const items = useMemo(() => inbox.data?.pages.flatMap((page) => page.items) ?? [], [inbox.data]);

  const open = (item: InboxNotification) => {
    if (item.readAt === null) {
      markRead.mutate(item.id, {
        onError: (failure) => pushErrorToast("Couldn’t mark the notification as read", failure),
      });
    }
    const href = safeHref(item.href);
    if (href !== null) void navigate({ href });
  };

  const refresh = () => void inbox.refetch();

  return (
    <div className="bg-surface-feed relative flex h-full min-h-0 flex-col">
      <header className="border-border-divider flex min-h-11 shrink-0 items-center gap-1 border-b py-2 pr-3 pl-4">
        <h1 className="text-fg-heading m-0 min-w-0 flex-1 text-[length:calc(var(--fs-base)+1px)] font-semibold">
          Notifications
        </h1>
        <ControlButton
          size="sm"
          disabled={unread === 0 || markAllRead.isPending}
          onClick={() =>
            markAllRead.mutate(undefined, {
              onError: (failure) => pushErrorToast("Couldn’t mark notifications as read", failure),
            })
          }
        >
          Mark all as read
        </ControlButton>
        <IconButton label="Refresh Notifications" onClick={refresh}>
          <RotateCw size={14} aria-hidden="true" />
        </IconButton>
      </header>
      <div className="research-reading-surface min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-feed mx-auto flex w-full flex-col pb-6">
          {inbox.isError ? (
            <div className="text-fg-muted flex flex-col items-center gap-3 px-4 py-10 text-center text-sm">
              <p className="m-0" role="alert">
                {inbox.error instanceof Error
                  ? inbox.error.message
                  : "Couldn’t load notifications."}
              </p>
              <ControlButton size="sm" onClick={refresh}>
                Retry
              </ControlButton>
            </div>
          ) : items.length === 0 ? (
            <div className="text-fg-muted px-4 py-10 text-center text-sm">
              {inbox.isLoading ? "Loading notifications…" : "No notifications."}
            </div>
          ) : (
            <>
              <ul
                aria-label="Notifications"
                aria-busy={inbox.isFetching}
                className="m-0 flex list-none flex-col p-0"
              >
                {items.map((item) => {
                  const isUnread = item.readAt === null;
                  return (
                    <li key={item.id} className="border-border-divider border-b">
                      <button
                        type="button"
                        data-notification={item.id}
                        data-unread={isUnread ? "" : undefined}
                        aria-label={`${isUnread ? "Unread: " : ""}${item.title}`}
                        aria-describedby={item.body ? `notification-${item.id}-body` : undefined}
                        className={cn(
                          "grid w-full min-w-0 cursor-pointer grid-cols-[8px_1fr_auto] items-baseline gap-x-2.5 border-0 bg-transparent px-3.5 py-3 text-left",
                          "hover:bg-surface-fill-hover",
                          FOCUS_RING,
                        )}
                        onClick={() => open(item)}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-2 self-center rounded-full",
                            isUnread ? "bg-accent" : "bg-transparent",
                          )}
                        />
                        <span
                          className={cn(
                            "min-w-0 truncate text-[length:calc(var(--fs-base)+0.5px)]",
                            isUnread ? "text-fg-primary font-medium" : "text-fg-secondary",
                          )}
                        >
                          {item.title}
                        </span>
                        <time
                          className="text-fg-subtle shrink-0 text-xs tabular-nums"
                          dateTime={new Date(item.createdAt).toISOString()}
                          title={new Date(item.createdAt).toLocaleString()}
                        >
                          {formatRelativeTime(item.createdAt)}
                        </time>
                        {item.body ? (
                          <span
                            id={`notification-${item.id}-body`}
                            className="text-fg-muted col-start-2 col-end-4 mt-0.5 line-clamp-2 text-sm [overflow-wrap:anywhere]"
                          >
                            {item.body}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {inbox.hasNextPage ? (
                <div className="flex justify-center px-4 py-4">
                  <ControlButton
                    size="sm"
                    disabled={inbox.isFetchingNextPage}
                    onClick={() => void inbox.fetchNextPage()}
                  >
                    {inbox.isFetchingNextPage ? "Loading…" : "Show older notifications"}
                  </ControlButton>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
