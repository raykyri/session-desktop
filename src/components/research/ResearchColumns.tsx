import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { RESEARCH_SINGLE_COLUMN_BELOW } from "../../lib/researchBranchView";
import { listenToResearchNodeOpen } from "../../lib/researchShortcuts";

const FEED_MIN_WIDTH = 240;
const FEED_MAX_WIDTH = 320;
/** The conversation keeps at least this much before the feed grows past its minimum. */
const CONVERSATION_MIN_WIDTH = 620;

/** The feed column's width: 240–320px, set by the width of the column area
 * alone, so opening a conversation, the branch drawer, or pinned columns
 * never changes it. */
export function researchFeedColumnWidth(availableWidth: number): number {
  const width = Number.isFinite(availableWidth) ? availableWidth - CONVERSATION_MIN_WIDTH : 0;
  return Math.round(Math.max(FEED_MIN_WIDTH, Math.min(FEED_MAX_WIDTH, width)));
}

/** The conversation column's width: the rest of the column area beside the
 * feed, or the whole area when one column shows at a time. Pinned columns
 * add to the row's width instead of taking from this. */
export function researchConversationColumnWidth(availableWidth: number): number {
  const area = Number.isFinite(availableWidth) ? Math.max(0, Math.round(availableWidth)) : 0;
  return area < RESEARCH_SINGLE_COLUMN_BELOW ? area : area - researchFeedColumnWidth(area);
}

/** Which columns show. In single-column mode the feed shows until a thread
 * opens, and again after the thread's Back to feed; the other column is
 * hidden (kept mounted, so it keeps its scroll position) and inert. */
export function researchColumnsShown({
  single,
  hasDocument,
  feedFocused,
}: {
  single: boolean;
  hasDocument: boolean;
  feedFocused: boolean;
}): { showsFeed: boolean; feedHidden: boolean; contentHidden: boolean } {
  const showsFeed = !hasDocument || feedFocused;
  return { showsFeed, feedHidden: single && !showsFeed, contentHidden: single && showsFeed };
}

interface ResearchColumnsLayout {
  /** The column area's width, feed included. */
  areaWidth: number;
  conversationWidth: number;
  singleColumn: boolean;
  /** The horizontally scrolling row that holds the feed, the conversation,
   * and pinned columns. */
  row: HTMLElement | null;
  /** A layer over the column area, outside the scrolling row, for the branch
   * drawer and the find bar: they stay put while the row scrolls. */
  overlay: HTMLElement | null;
  /** The feed is column 0 for `[` and `]`, and the column shown in
   * single-column mode after Back. */
  feedFocused: boolean;
  focusFeed: (options?: { moveFocus?: boolean }) => void;
  /** A conversation column took focus. */
  releaseFeed: () => void;
}

export const ResearchColumnsContext = createContext<ResearchColumnsLayout | null>(null);

/** Scrolls the row horizontally so `column` is in view, by as little as
 * possible (no-op when it already is). */
export function showResearchColumn(row: HTMLElement | null, column: HTMLElement | null, behavior: ScrollBehavior) {
  if (!row || !column) {
    return;
  }
  const rect = column.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  let dx = rect.right > bounds.right ? rect.right - bounds.right : 0;
  if (rect.left - dx < bounds.left) {
    dx = rect.left - bounds.left;
  }
  if (dx) {
    row.scrollBy({ left: dx, behavior });
  }
}

/** The column area: one horizontally scrolling row with the feed column,
 * then the content column (the open thread with its pinned branch columns, or
 * a placeholder). Pinning a branch scrolls the feed out of view and keeps
 * the conversation where it is. Below RESEARCH_SINGLE_COLUMN_BELOW only one
 * column shows: the feed, or the thread once one is open (its header's Back
 * returns to the feed). */
export default function ResearchColumns({
  hasDocument,
  documentKey,
  feed,
  children,
}: {
  hasDocument: boolean;
  /** Changes when another thread opens; showing a thread hands it the focus. */
  documentKey: string | null;
  feed: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLElement>(null);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(CONVERSATION_MIN_WIDTH + FEED_MAX_WIDTH);
  const [feedFocused, setFeedFocused] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setAvailableWidth(root.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Opening a thread, or a node of the open one, shows the thread.
  useEffect(() => setFeedFocused(false), [documentKey]);
  useEffect(() => listenToResearchNodeOpen(() => setFeedFocused(false)), []);

  const focusFeed = useCallback(
    ({ moveFocus = false }: { moveFocus?: boolean } = {}) => {
      setFeedFocused(true);
      window.requestAnimationFrame(() => {
        row?.scrollTo({ left: 0, behavior: "auto" });
        if (moveFocus) {
          feedRef.current
            ?.querySelector<HTMLElement>(".research-feed-header-title")
            ?.focus({ preventScroll: true });
        }
      });
    },
    [row],
  );
  const releaseFeed = useCallback(() => setFeedFocused(false), []);

  const single = availableWidth < RESEARCH_SINGLE_COLUMN_BELOW;
  const conversationWidth = researchConversationColumnWidth(availableWidth);
  const { showsFeed, feedHidden, contentHidden } = researchColumnsShown({ single, hasDocument, feedFocused });
  const layout = useMemo<ResearchColumnsLayout>(
    () => ({
      areaWidth: availableWidth,
      conversationWidth,
      singleColumn: single,
      row,
      overlay,
      feedFocused: hasDocument && feedFocused,
      focusFeed,
      releaseFeed,
    }),
    [availableWidth, conversationWidth, feedFocused, focusFeed, hasDocument, overlay, releaseFeed, row, single],
  );
  return (
    <ResearchColumnsContext.Provider value={layout}>
      <div
        ref={rootRef}
        className={`research-columns${hasDocument ? " has-document" : ""}${single ? " is-single" : ""}${
          single && showsFeed ? " shows-feed" : ""
        }`}
        style={
          {
            "--research-feed-column-width": `${researchFeedColumnWidth(availableWidth)}px`,
            "--research-conversation-width": `${conversationWidth}px`,
          } as CSSProperties
        }
      >
        <div ref={setRow} className="research-columns-row">
          {feed ? (
            <section
              ref={feedRef}
              className={`research-feed-column${hasDocument && feedFocused ? " is-focused" : ""}`}
              data-research-column="feed"
              aria-label="Feed"
              inert={feedHidden || undefined}
              onClickCapture={(event) => {
                // The open thread's own card shows the thread again.
                if (
                  !(event.target instanceof Element) ||
                  !event.target.closest(".research-feed-card.is-selected .research-feed-card-hit")
                ) {
                  return;
                }
                setFeedFocused(false);
                if (single) {
                  // In single-column mode it only switches back: reopening
                  // would scroll the thread to its first question, and the
                  // hidden thread kept its place.
                  event.stopPropagation();
                  window.requestAnimationFrame(() =>
                    rootRef.current
                      ?.querySelector<HTMLElement>(
                        ".research-content-column .research-conv-column:not(.is-hidden) .research-column-title",
                      )
                      ?.focus({ preventScroll: true }),
                  );
                }
              }}
            >
              {feed}
            </section>
          ) : null}
          <div className="research-content-column" inert={contentHidden || undefined}>
            {children}
          </div>
        </div>
        <div ref={setOverlay} className="research-columns-overlay" inert={contentHidden || undefined} />
      </div>
    </ResearchColumnsContext.Provider>
  );
}
