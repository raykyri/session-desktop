// Follow and Bookmark for a thread, shared by the Home card and the thread's
// prompt footer so the two surfaces read the same: a label (Bookmark with its
// glyph), no box,
// the strong foreground on hover and while the state is on.

import { Bookmark, BookmarkCheck } from "lucide-react";

import { cn } from "../../lib/cn.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

const ACTION_CLASS =
  "text-fg-subtle hover:not-disabled:text-fg-strong flex items-center gap-1 rounded-sm border-0 bg-transparent p-0 " +
  "aria-pressed:text-fg-secondary disabled:cursor-default active:not-disabled:opacity-70 " +
  FOCUS_RING;

export function ThreadActions({
  followed,
  bookmarked,
  onToggleFollow,
  onToggleBookmark,
  busy = false,
  className,
}: {
  followed: boolean;
  bookmarked: boolean;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
  /** A toggle is in flight: both controls wait so a second click cannot send
   * the stale value again. */
  busy?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button
        type="button"
        aria-pressed={followed}
        title={followed ? "Stop following this thread" : "Follow this thread"}
        className={ACTION_CLASS}
        disabled={busy}
        onClick={onToggleFollow}
      >
        <span>{followed ? "Following" : "Follow"}</span>
      </button>
      <button
        type="button"
        aria-pressed={bookmarked}
        title={bookmarked ? "Remove bookmark" : "Bookmark this thread"}
        className={ACTION_CLASS}
        disabled={busy}
        onClick={onToggleBookmark}
      >
        {bookmarked ? (
          <BookmarkCheck size={12} aria-hidden="true" />
        ) : (
          <Bookmark size={12} aria-hidden="true" />
        )}
        <span>{bookmarked ? "Bookmarked" : "Bookmark"}</span>
      </button>
    </div>
  );
}
