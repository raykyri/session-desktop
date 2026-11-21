// The notifications page (02 W2.6, decision P10; the mock's `notifPage`):
// "Notifications" with "Mark all as read", the summary line, and the
// notification records of the user log, newest first, in a box. Each row:
// the actor's avatar with a kind badge, the text, "#channel · 3h" ("Invites ·
// 3h" for an invite), and the unread tint and dot. Opening a row marks it
// read and goes to the thread in its channel's feed with the item selected
// (the feed scrolls it into place, keeps the bar shown and flashes the
// card), or to Invites. Opening the page does not mark anything read.

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { cn } from "../../lib/cn.js";
import { useReplica, useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { useNow } from "../../replica/queries.js";
import { UNKNOWN } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { Avatar } from "../../ui/Avatar.js";
import { relTime } from "../feed/format.js";
import {
  AtIcon,
  BellIcon,
  BranchIcon,
  BubbleIcon,
  PersonIcon,
  RemovedIcon,
  ReplyArrowIcon,
} from "../feed/icons.js";
import { PageFrame } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";

import {
  notifParts,
  notificationsOf,
  unloadedThreads,
  unreadLine,
  type NotifKind,
  type NotifRow,
} from "./notifications.js";

const KIND_ICON: Record<NotifKind, () => React.ReactElement> = {
  mention: AtIcon,
  reply: ReplyArrowIcon,
  branch: BranchIcon,
  comment: BubbleIcon,
  removed: RemovedIcon,
  invite_used: PersonIcon,
};

export function NotificationsPage() {
  const source = useReplica();
  const writes = useWrites();
  const rows = useReplicaQuery(notificationsOf, []);
  const unloaded = useReplicaQuery(unloadedThreads, []);
  // a thread outside the window is fetched for its title
  useEffect(() => {
    if (unloaded === UNKNOWN) return;
    for (const u of unloaded) source.open?.(u.thread, u.space);
  }, [source, unloaded]);

  const list = rows === UNKNOWN ? null : rows;
  const unread = list?.filter((r) => !r.read).length ?? 0;
  const markAll = async () => {
    const outcome = await writes.send("notifications.markAllRead", {});
    if (outcome.ok && !outcome.unsent) showToast("All notifications marked as read.");
  };

  return (
    <PageFrame
      title="Notifications"
      narrow
      action={
        <button
          type="button"
          className="btn2 sm"
          disabled={unread === 0}
          onClick={() => void markAll()}
        >
          Mark all as read
        </button>
      }
    >
      {list === null ? (
        <p role="status" aria-busy="true" className="nsub">
          Loading notifications…
        </p>
      ) : list.length === 0 ? (
        <NotificationsEmpty />
      ) : (
        <>
          <p className="nsub">
            {unreadLine(unread)} Mentions, replies to your posts, branches and comments on your
            asks, removals, and invites people used.
          </p>
          <ul className="nlist box">
            {list.map((row) => (
              <li key={row.id}>
                <NotificationRow row={row} />
              </li>
            ))}
          </ul>
        </>
      )}
    </PageFrame>
  );
}

function NotificationRow({ row }: { row: NotifRow }) {
  const writes = useWrites();
  const navigate = useNavigate();
  const now = useNow();
  const parts = notifParts(row);
  const Icon = KIND_ICON[row.type];
  const open = () => {
    if (!row.read) void writes.send("notifications.markRead", { id: row.id });
    const target = row.target;
    if (target?.kind === "invites") void navigate({ to: "/invites" });
    else if (target)
      void navigate({
        to: "/c/$name",
        params: { name: target.channel },
        search: { t: target.thread, sel: target.sel },
      });
  };
  return (
    <button
      type="button"
      className={cn("nrow", !row.read && "unread")}
      data-notif={row.type}
      onClick={open}
    >
      <span className="nav-av">
        <Avatar handle={row.actor ?? "?"} size="sm" />
        <span className={`nk nk-${row.type}`} aria-hidden="true">
          <Icon />
        </span>
      </span>
      <span className="ntx">
        <b>{parts.who}</b>
        {parts.text}
        {parts.quote !== null ? (
          <span className={parts.reason ? "nr" : "nt"}>“{parts.quote}”</span>
        ) : null}
        {parts.code ? <span className="nt">{parts.code}</span> : null}
        <small>
          {row.type === "invite_used" ? "Invites · " : row.channel ? `#${row.channel} · ` : ""}
          <time dateTime={row.createdAt}>{relTime(row.createdAt, now)}</time>
        </small>
      </span>
      {row.read ? null : <span className="ndot" role="img" aria-label="Unread" />}
    </button>
  );
}

function NotificationsEmpty() {
  return (
    <div className="estate">
      <span className="eic" aria-hidden="true">
        <BellIcon />
      </span>
      <h3>No notifications yet</h3>
      <p>
        You are notified when someone mentions you, replies to your post, branches or comments on
        your ask, uses one of your invites, or when a channel owner removes your thread.
      </p>
      <Link to="/invites" className="btn2 sm">
        Invite someone
      </Link>
    </div>
  );
}
