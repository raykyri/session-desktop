import type { ReactNode } from "react";
import { LoaderCircle, Terminal } from "lucide-react";
import ResearchThreadActions from "./ResearchThreadActions";
import { ResearchRecapPendingLine } from "./ResearchRecap";

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button"));
}

interface ResearchFeedPostProps {
  /** An exported terminal conversation carries a glyph at the start of the
   * footer; questions and notes (network posts and saved links) carry none. */
  kind?: "question" | "note" | "conversation";
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
  /** A run in the thread failed since it was last viewed. Takes the unread
   * dot's place, since a failure is also an unseen change. */
  failed?: boolean;
  /** Labelled counts of the replies and follow-ups under this item, such as
   * ["2 replies", "1 follow-up"]. Each opens the item. */
  counts?: string[];
  followed?: boolean;
  bookmarked?: boolean;
  onToggleFollow?: () => void;
  onToggleBookmark?: () => void;
  onOpen: () => void;
  onContextMenu: (clientX: number, clientY: number) => void;
}

/** One item in the Home feed column: the thread title, the question clamped
 * to four lines, the answer's summary, and a footer with the time and counts,
 * then Follow and Bookmark at its trailing edge. The whole item opens the
 * thread. Follow and Bookmark wait until the answer settles. */
export default function ResearchFeedPost({
  kind = "question",
  time,
  title,
  renderBody,
  recap,
  recapPending = false,
  running = false,
  selected = false,
  unread = false,
  failed = false,
  counts = [],
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
  const showCounts = counts.length > 0;
  // Only a terminal conversation is marked: a question already reads as one
  // by its title and summary, and a speech-bubble glyph beside the counts
  // would read as a reply count.
  const kindGlyph = kind === "conversation" ? <Terminal size={12} aria-hidden="true" /> : null;
  return (
    <div
      className={`research-feed-post${selected ? " is-selected" : ""}`}
      onClick={(event) => {
        // Clicking anywhere in the post opens it; keyboard and assistive tech
        // reach it through the title (or, untitled, the time), so the links,
        // embeds, Follow and Bookmark inside stay separate controls.
        if (!isInteractiveTarget(event.target)) onOpen();
      }}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      {failed ? (
        <span
          className="research-feed-post-marker research-feed-post-failed"
          role="img"
          aria-label="Failed since last viewed"
          title="Failed since last viewed — open to acknowledge"
        >
          !
        </span>
      ) : unread ? (
        <span
          className="research-feed-post-marker research-feed-post-unread"
          role="img"
          aria-label="Updated"
        />
      ) : null}
      <div className="research-feed-post-main">
        <div className="research-feed-post-open">
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
        {showCounts || showActions || showTime ? (
          <div className="research-feed-post-footer">
            <span className="research-feed-post-meta">
              {kindGlyph && (showTime || showCounts) ? (
                <span className="research-feed-post-kind">{kindGlyph}</span>
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
              {showCounts
                ? counts.map((label, index) => (
                    // Each count keeps its separator, so a wrapped line never
                    // ends on a dangling "·".
                    <span key={label} className="research-feed-post-meta-item">
                      {showTime || index > 0 ? (
                        <span className="research-feed-post-meta-separator" aria-hidden="true">
                          ·
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="control-button research-feed-post-count"
                        tabIndex={-1}
                        aria-label={`Open ${label}`}
                        onClick={onOpen}
                      >
                        {label}
                      </button>
                    </span>
                  ))
                : null}
            </span>
            {showActions ? (
              <ResearchThreadActions
                followed={followed}
                bookmarked={bookmarked}
                onToggleFollow={onToggleFollow}
                onToggleBookmark={onToggleBookmark}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
