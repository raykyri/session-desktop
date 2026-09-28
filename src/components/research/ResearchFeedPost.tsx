import { useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { LoaderCircle, Reply, UserRound } from "lucide-react";
import ResearchThreadActions from "./ResearchThreadActions";
import { ResearchRecapPendingLine } from "./ResearchRecap";

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button"));
}

/** True when an element clips its content (a clamped block with more text). */
function isClipped(element: HTMLElement | null) {
  return Boolean(element && element.scrollHeight > element.clientHeight + 1);
}

export interface ResearchFeedPostProps {
  /** "asked Claude", "posted to your network", … — follows "You" in the header. */
  action: string;
  /** Relative time (and any context) after the action; omitted while running. */
  time?: ReactNode;
  /** The thread's generated title, shown above the question. */
  title?: string | null;
  /** Renders the question or note body. The body passes its prompt text
   * through `clamp`, which limits it to four lines until the post is expanded;
   * anything rendered outside it (link cards, embeds) shows in full. */
  renderBody: (clamp: (content: ReactNode) => ReactNode) => ReactNode;
  /** Changes whenever the clamped text changes, so Show more is re-measured
   * even when the clamped box keeps its size. */
  contentKey: string;
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
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpen: () => void;
  onContextMenu: (clientX: number, clientY: number) => void;
}

/** One item in the Home feed column: an avatar, "You <action> · time", the
 * thread title, the question clamped to four lines, the answer's summary, and
 * a footer with the follow-up count, Follow and Bookmark on the left and
 * Show more on the right. Follow and Bookmark wait until the answer settles. */
export default function ResearchFeedPost({
  action,
  time,
  title,
  renderBody,
  contentKey,
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
  expanded,
  onToggleExpanded,
  onOpen,
  onContextMenu,
}: ResearchFeedPostProps) {
  // Callback refs (state, not refs) so a clamped block that remounts — a tweet
  // resolving, a note switching between link card and text — is re-measured.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [summaryElement, setSummaryElement] = useState<HTMLParagraphElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const summary = recap?.trim() ?? "";

  // Show more appears only when the collapsed question or summary is cut off.
  // Measured rather than estimated so it follows the font, width and Markdown.
  useLayoutEffect(() => {
    if (expanded) return;
    const measure = () => setClipped(isClipped(body) || isClipped(summaryElement));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (body) observer.observe(body);
    if (summaryElement) observer.observe(summaryElement);
    return () => observer.disconnect();
  }, [expanded, body, summaryElement, summary, contentKey]);

  const showActions = !running && onToggleFollow && onToggleBookmark;
  const showMore = expanded || clipped;
  const clampClass = expanded ? "" : " is-clamped";
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
          <UserRound size={14} />
        </span>
        {unread ? (
          <span className="research-feed-post-unread" role="img" aria-label="Updated" />
        ) : null}
      </div>
      <div className="research-feed-post-main">
        <div className="research-feed-post-head">
          <span className="research-feed-post-author">You</span>
          <span className="research-feed-post-action">{action}</span>
          {!running && time ? (
            <>
              <span aria-hidden="true">·</span>
              {/* The time opens the item too: a saved link's only other
                  target is the link itself. */}
              <button
                type="button"
                className="control-button research-feed-post-time"
                title="Open"
                onClick={onOpen}
              >
                {time}
              </button>
            </>
          ) : null}
        </div>
        <div
          className="research-feed-post-open"
          role="button"
          tabIndex={0}
          aria-current={selected ? "true" : undefined}
          onClick={(event) => {
            if (!isInteractiveTarget(event.target)) onOpen();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onOpen();
          }}
        >
          {title ? <div className="research-feed-post-title">{title}</div> : null}
          {renderBody((content) => (
            <div
              ref={setBody}
              className={`research-feed-post-body${title ? "" : " is-lead"}${clampClass}`}
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
            <p
              ref={setSummaryElement}
              className={`research-summary-text research-feed-post-summary${clampClass}`}
            >
              Summary: {summary}
            </p>
          ) : recapPending && !running ? (
            <ResearchRecapPendingLine className="research-feed-post-summary" />
          ) : null}
        </div>
        {replyCount > 0 || showActions || showMore ? (
          <div className="research-feed-post-footer">
            {replyCount > 0 ? (
              <button
                type="button"
                className="control-button research-feed-post-count"
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
            {showMore ? (
              <button
                type="button"
                className="control-button research-feed-post-more"
                aria-expanded={expanded}
                onClick={onToggleExpanded}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
