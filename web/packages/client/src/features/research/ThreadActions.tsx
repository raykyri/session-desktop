// Follow and Bookmark for a thread, shared by the Home card and the thread's
// prompt footer so the two surfaces read the same: a label (Bookmark with its
// glyph), no box,
// the strong foreground on hover and while the state is on.

import { Bookmark, BookmarkCheck } from "lucide-react";

import { cn } from "../../lib/cn.js";

const ACTION_CLASS =
  "text-fg-subtle hover:text-fg-strong flex items-center gap-1 border-0 bg-transparent p-0 " +
  "aria-pressed:text-fg-secondary";

export function ThreadActions({
  followed,
  bookmarked,
  onToggleFollow,
  onToggleBookmark,
  className,
}: {
  followed: boolean;
  bookmarked: boolean;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button
        type="button"
        aria-pressed={followed}
        title={followed ? "Stop following this thread" : "Follow this thread"}
        className={ACTION_CLASS}
        onClick={onToggleFollow}
      >
        <span>{followed ? "Following" : "Follow"}</span>
      </button>
      <button
        type="button"
        aria-pressed={bookmarked}
        title={bookmarked ? "Remove bookmark" : "Bookmark this thread"}
        className={ACTION_CLASS}
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
