import type { ReactNode } from "react";
import { LoaderCircle, MessageCircle, Reply, StickyNote } from "lucide-react";
import ResearchThreadActions from "./ResearchThreadActions";
import { ResearchRecapPendingLine } from "./ResearchRecap";

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button"));
}

interface ResearchFeedPostProps {
  /** Network posts and saved notes use a note glyph. */
  isNote?: boolean;
  /** Relative time in the footer after Bookmark; omitted while running. */
  time?: ReactNode;
  /** The thread's generated title, shown above the question. */
  title?: string | null;
  /** Renders the question or note body. The body passes its prompt text
   * through `clamp`, which limits it to four lines;
   * anything rendered outside it (link cards, embeds) shows in full. */
  renderBody: (clamp: (content: ReactNode) => ReactNode) => ReactNode;
  /** The answer's recap, shown as an italic "Summary:" line. */
  recap?: string | null;
  recapPending?: boolean;
  running?: boolean;
  selected?: boolean;
  /** The thread changed since it was last viewed. */
  unread?: boolean;
  /** Follow-ups (and, for network posts, replies) under this item. */
  replyCount?: number;
  replyCountLabel?: string;
  followed?: boolean;
  bookmarked?: boolean;
  onToggleFollow?: () => void;
  onToggleBookmark?: () => void;
  onOpen: () => void;
  onContextMenu: (clientX: number, clientY: number) => void;
}

/** One item in the Home feed column: an avatar, the
 * thread title, the question clamped to four lines, the answer's summary, and
 * a footer with the follow-up count, Follow, Bookmark and time.
 * Follow and Bookmark wait until the answer settles. */
export default function ResearchFeedPost({
  isNote = false,
  time,
  title,
  renderBody,
  recap,
  recapPending = false,
  running = false,
  selected = false,
  unread = false,
  replyCount = 0,
  replyCountLabel,
  followed = false,
  bookmarked = false,
  onToggleFollow,
  onToggleBookmark,
  onOpen,
  onContextMenu,
}: ResearchFeedPostProps) {
  const summary = recap?.trim() ?? "";

  const showActions = !running && onToggleFollow && onToggleBookmark;
  const showTime = !running && Boolean(time);
  return (
    <div
      className={`research-feed-post${selected ? " is-selected" : ""}`}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <div className="research-feed-post-avatar">
        <span className="research-feed-post-avatar-glyph" aria-hidden="true">
          {isNote ? <StickyNote size={14} /> : <MessageCircle size={14} />}
        </span>
        {unread ? (
          <span className="research-feed-post-unread" role="img" aria-label="Updated" />
        ) : null}
      </div>
      <div className="research-feed-post-main">
        {/* Clicking anywhere in the body opens the post; keyboard and assistive
            tech reach it through the title (or, untitled, the time), so the
            links and embeds inside the body stay separate controls. */}
        <div
          className="research-feed-post-open"
          onClick={(event) => {
            if (!isInteractiveTarget(event.target)) onOpen();
          }}
        >
          {title ? (
            <button
              type="button"
              className="control-button research-feed-post-title"
              aria-current={selected ? "true" : undefined}
              onClick={onOpen}
            >
              {title}
            </button>
          ) : null}
          {renderBody((content) => (
            <div
              className={`research-feed-post-body${title ? "" : " is-lead"} is-clamped`}
            >
              {content}
            </div>
          ))}
          {running ? (
            <span className="research-feed-post-status" role="status">
              <LoaderCircle size={12} aria-hidden="true" />
              Generating answer
            </span>
          ) : null}
          {summary ? (
            <p className="research-summary-text research-feed-post-summary is-clamped">
              Summary: {summary}
            </p>
          ) : recapPending && !running ? (
            <ResearchRecapPendingLine className="research-feed-post-summary" />
          ) : null}
        </div>
        {replyCount > 0 || showActions || showTime ? (
          <div className="research-feed-post-footer">
            {replyCount > 0 ? (
              <button
                type="button"
                className="control-button research-feed-post-count"
                tabIndex={-1}
                aria-label={`Open ${replyCountLabel}`}
                title={replyCountLabel}
                onClick={onOpen}
              >
                <Reply size={13} aria-hidden="true" />
                {replyCount}
              </button>
            ) : null}
            {showActions ? (
              <ResearchThreadActions
                followed={followed}
                bookmarked={bookmarked}
                onToggleFollow={onToggleFollow}
                onToggleBookmark={onToggleBookmark}
              />
            ) : null}
            {showTime ? (
              /* An untitled post (a note or saved link) opens from its time;
                 its body's only other target may be the link itself. */
              <button
                type="button"
                className="control-button research-feed-post-time"
                aria-label={title ? undefined : "Open post"}
                tabIndex={title ? -1 : undefined}
                onClick={onOpen}
              >
                {time}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
