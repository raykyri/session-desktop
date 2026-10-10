import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import {
  columnAttributes,
  columnIdOf,
  columnSelector,
  isMessagesColumnId,
  type ResearchColumnId,
} from "../../lib/researchColumns";

const clampWidth = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, value)));

/** Column widths from the strip's width alone (the column area: the window
 * less the sidebar), so opening, closing or switching a level never resizes
 * a column: the feed is 21% (240–300px), each pair's messages column 18%
 * (220–280px) and its answer column 44% (340–660px). */
export function researchColumnWidths(stripWidth: number): { feed: number; turns: number; answer: number } {
  const width = Number.isFinite(stripWidth) ? Math.max(0, stripWidth) : 0;
  return {
    feed: clampWidth(width * 0.21, 240, 300),
    turns: clampWidth(width * 0.18, 220, 280),
    answer: clampWidth(width * 0.44, 340, 660),
  };
}

/** A feed width set with the feed's resize handle replaces the automatic
 * width. It is kept per device, like other layout state. */
const FEED_WIDTH_KEY = "session.research.feedWidth";
const RESEARCH_FEED_MIN_WIDTH = 240;
const RESEARCH_FEED_MAX_WIDTH = 560;

/** The widest the feed may be: 560px, and at most half of the column area. */
function researchFeedMaxWidth(stripWidth: number): number {
  return Math.max(RESEARCH_FEED_MIN_WIDTH, Math.min(RESEARCH_FEED_MAX_WIDTH, Math.floor(stripWidth / 2)));
}

function loadFeedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(FEED_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveFeedWidth(width: number | null) {
  try {
    if (width == null) localStorage.removeItem(FEED_WIDTH_KEY);
    else localStorage.setItem(FEED_WIDTH_KEY, String(width));
  } catch {
    // Storage unavailable: the width lasts until the window reloads.
  }
}

/** The system setting or the app's own Reduce motion setting. */
function prefersReducedMotion() {
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
    document.querySelector(".app-shell.reduce-motion") !== null
  );
}

// Disable scroll animation until the first pointer, key, or wheel input
// so loading or restoring a thread sets its scroll positions immediately.
let interacted = false;
let interactionListening = false;
function listenForInteraction() {
  if (interactionListening) return;
  interactionListening = true;
  for (const type of ["pointerdown", "keydown", "wheel"]) {
    window.addEventListener(
      type,
      () => {
        interacted = true;
      },
      { capture: true, passive: true },
    );
  }
}

export function researchScrollBehavior(): ScrollBehavior {
  return interacted && !prefersReducedMotion() ? "smooth" : "auto";
}

/** Scrolls the strip by the least distance that shows `first` through
 * `last` (one column, or a pair), keeping `first`'s left edge in view when
 * they don't fit. Nothing moves when they are already in view. */
export function revealResearchColumns(
  row: HTMLElement | null,
  first: HTMLElement | null,
  last: HTMLElement | null = first,
  behavior: ScrollBehavior = researchScrollBehavior(),
) {
  if (!row || !first || !last) return;
  const viewLeft = row.scrollLeft;
  const viewWidth = row.clientWidth;
  const left = first.offsetLeft;
  const right = last.offsetLeft + last.offsetWidth;
  if (left >= viewLeft - 1 && right <= viewLeft + viewWidth + 1) return;
  const target = right - left > viewWidth || left < viewLeft ? left : right - viewWidth;
  row.scrollTo({ left: target, behavior });
}

/** After a level opens or closes: shows the strip's last column at its right
 * edge, adjusted so the column `focusId` stays in view. */
export function settleResearchStrip(
  row: HTMLElement | null,
  focusId: ResearchColumnId | null,
  behavior: ScrollBehavior = researchScrollBehavior(),
) {
  if (!row) return;
  const focus = focusId ? row.querySelector<HTMLElement>(columnSelector(focusId)) : null;
  const columns = [...row.querySelectorAll<HTMLElement>(columnSelector())];
  const last = columns[columns.length - 1];
  if (!last) return;
  const viewWidth = row.clientWidth;
  let left = Math.max(0, last.offsetLeft + last.offsetWidth - viewWidth);
  if (focus) {
    if (focus.offsetLeft < left) left = focus.offsetLeft;
    if (focus.offsetLeft + focus.offsetWidth > left + viewWidth) {
      left = focus.offsetLeft + focus.offsetWidth - viewWidth;
    }
  }
  if (Math.abs(row.scrollLeft - left) > 1) {
    row.scrollTo({ left, behavior });
  }
}

interface ResearchColumnsLayout {
  /** The horizontally scrolling strip: the feed, then each level's pair. */
  row: HTMLElement | null;
  /** A layer over the column area, outside the strip, for the find bar: it
   * stays put while the strip scrolls. */
  overlay: HTMLElement | null;
  /** Focus is in the feed column. */
  feedCurrent: boolean;
  /** Shows the feed and focuses its selected row (or its title). */
  focusFeed: () => void;
  /** After a feed row opened a thread from the keyboard: focuses the
   * selected message of its first level (`deepest`: of its deepest level)
   * once it has rendered. A draft's column keeps focus off its ask box. */
  focusOpenedThread: (deepest: boolean) => void;
}

export const ResearchColumnsContext = createContext<ResearchColumnsLayout | null>(null);

/** The column area: one horizontally scrolling strip with the feed column,
 * then the content (the open thread's column pairs, or a filler). Column
 * widths come from the area's width, so the strip scrolls sideways when the
 * pairs don't fit. */
export default function ResearchColumns({
  hasDocument,
  feed,
  children,
}: {
  hasDocument: boolean;
  feed: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLElement>(null);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(1232);
  const [feedCurrent, setFeedCurrent] = useState(false);
  const [feedWidth, setFeedWidth] = useState<number | null>(loadFeedWidth);

  useEffect(listenForInteraction, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setAvailableWidth(root.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Mostly horizontal wheel and trackpad input (and Shift+wheel) scrolls the
  // strip, even over a column that only scrolls vertically. Capture phase, so
  // a column's swipe navigation sees the event as handled while the strip can
  // still move that way.
  useEffect(() => {
    if (!row) return;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? row.clientWidth : 1;
      let dx = event.deltaX;
      let dy = event.deltaY;
      if (event.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      if (!dx || Math.abs(dx) <= Math.abs(dy)) return;
      // A wide table or code block that can still scroll that way keeps it.
      for (
        let element = event.target instanceof Element ? event.target : null;
        element && element !== row;
        element = element.parentElement
      ) {
        if (element.scrollWidth - element.clientWidth <= 1) continue;
        const overflowX = getComputedStyle(element).overflowX;
        if (overflowX !== "auto" && overflowX !== "scroll") continue;
        if ((dx < 0 && element.scrollLeft > 0) || (dx > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth - 1)) {
          return;
        }
      }
      const max = row.scrollWidth - row.clientWidth;
      if ((dx < 0 && row.scrollLeft > 0) || (dx > 0 && row.scrollLeft < max - 1)) {
        row.scrollLeft += dx * unit;
        event.preventDefault();
      }
    };
    row.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => row.removeEventListener("wheel", onWheel, { capture: true });
  }, [row]);

  // Match all column headers to the tallest wrapped title, with a minimum
  // height of 43px (44px including the border).
  useEffect(() => {
    if (!row) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const bars = [...row.querySelectorAll<HTMLElement>("[data-research-header-bar]")];
      const tallest = Math.max(43, ...bars.map((bar) => bar.offsetHeight));
      const value = `${tallest}px`;
      if (row.style.getPropertyValue("--research-header-height") !== value) {
        row.style.setProperty("--research-header-height", value);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    const resize = new ResizeObserver(schedule);
    resize.observe(row);
    const observed = new Set<Element>();
    const observeBars = () => {
      for (const bar of row.querySelectorAll("[data-research-header-bar]")) {
        if (!observed.has(bar)) {
          observed.add(bar);
          resize.observe(bar);
        }
      }
      schedule();
    };
    observeBars();
    const mutations = new MutationObserver(observeBars);
    mutations.observe(row, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [row]);

  // The feed is the current column while focus is in it.
  useEffect(() => {
    const feedColumn = feedRef.current;
    if (!row) return;
    const onFocusIn = (event: FocusEvent) => {
      setFeedCurrent(Boolean(feedColumn && event.target instanceof Node && feedColumn.contains(event.target)));
    };
    row.addEventListener("focusin", onFocusIn);
    return () => row.removeEventListener("focusin", onFocusIn);
  }, [row]);

  const widths = researchColumnWidths(availableWidth);
  const feedMax = researchFeedMaxWidth(availableWidth);
  const clampFeed = (width: number) => clampWidth(width, RESEARCH_FEED_MIN_WIDTH, feedMax);
  const shownFeedWidth = feedWidth == null ? widths.feed : clampFeed(feedWidth);
  const setFeedWidthAndSave = (width: number | null) => {
    setFeedWidth(width);
    saveFeedWidth(width);
  };

  // The handle on the feed's right edge works like the sidebar's: drag, or
  // Left/Right (Shift for larger steps). A double-click returns the feed to
  // its automatic width.
  const startFeedResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const startX = event.clientX;
    const startWidth = shownFeedWidth;
    let lastWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: globalThis.PointerEvent) => {
      lastWidth = clampFeed(startWidth + moveEvent.clientX - startX);
      setFeedWidth(lastWidth);
    };
    const stop = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (lastWidth !== startWidth) saveFeedWidth(lastWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const resizeFeedWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 16;
    setFeedWidthAndSave(clampFeed(shownFeedWidth + (event.key === "ArrowRight" ? step : -step)));
  };
  const layout = useMemo<ResearchColumnsLayout>(
    () => ({
      row,
      overlay,
      feedCurrent,
      focusFeed: () => {
        const feedColumn = feedRef.current;
        if (!feedColumn) return;
        revealResearchColumns(row, feedColumn);
        (
          feedColumn.querySelector<HTMLElement>(
            ".research-feed-card.is-selected .research-feed-card-hit, .research-feed-child.is-selected .research-feed-child-open",
          ) ?? feedColumn.querySelector<HTMLElement>(".research-feed-header-title")
        )?.focus({ preventScroll: true });
      },
      focusOpenedThread: (deepest) => {
        const started = performance.now();
        const attempt = () => {
          // The messages-side columns (a level's messages, post or pending
          // column, or a draft), left to right.
          const columns = [...(row?.querySelectorAll<HTMLElement>(columnSelector()) ?? [])].filter((element) =>
            isMessagesColumnId(element.dataset.researchColumn),
          );
          const column = deepest ? columns[columns.length - 1] : columns[0];
          const target = column?.querySelector<HTMLElement>(".research-msg-row.is-selected .research-msg-hit");
          if (target && column) {
            target.focus({ preventScroll: true });
            // Scroll the focused column into view.
            settleResearchStrip(row, columnIdOf(column));
            return;
          }
          if (!column?.classList.contains("research-draft-view") && performance.now() - started < 1500) {
            requestAnimationFrame(attempt);
          }
        };
        requestAnimationFrame(attempt);
      },
    }),
    [feedCurrent, overlay, row],
  );
  return (
    <ResearchColumnsContext.Provider value={layout}>
      <div
        ref={rootRef}
        className={`research-columns${hasDocument ? " has-document" : ""}`}
        style={
          {
            "--research-feed-column-width": `${shownFeedWidth}px`,
            "--research-turns-width": `${widths.turns}px`,
            "--research-answer-width": `${widths.answer}px`,
          } as CSSProperties
        }
      >
        <div ref={setRow} className="research-columns-row">
          {feed ? (
            <section
              ref={feedRef}
              className="research-feed-column"
              {...columnAttributes({ id: "feed", role: "feed" })}
              aria-label="Feed"
            >
              {feed}
              <div
                className="research-feed-resizer"
                role="separator"
                aria-label="Resize feed"
                aria-orientation="vertical"
                aria-valuemin={RESEARCH_FEED_MIN_WIDTH}
                aria-valuemax={feedMax}
                aria-valuenow={shownFeedWidth}
                title="Drag to resize · double-click to reset"
                tabIndex={0}
                onPointerDown={startFeedResize}
                onKeyDown={resizeFeedWithKeyboard}
                onDoubleClick={() => setFeedWidthAndSave(null)}
              />
            </section>
          ) : null}
          <div className="research-content-column">{children}</div>
        </div>
        <div ref={setOverlay} className="research-columns-overlay" />
      </div>
    </ResearchColumnsContext.Provider>
  );
}
