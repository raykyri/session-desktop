import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  COLUMN_ROW_SELECTOR,
  columnAttributes,
  columnIdOf,
  columnSelector,
  isMessagesColumnId,
  type ResearchColumnId,
} from "../../lib/researchColumns";
import { isEditableTarget } from "../../lib/appHelpers";
import { researchCycleDirection, type ResearchCycleRequest } from "../../lib/researchSiblingCycle";
import {
  loadResearchColumnWidths,
  researchColumnWidthBounds,
  researchColumnWidths,
  saveResearchColumnWidth,
  shownResearchColumnWidths,
  type ResearchColumnWidthKind,
  type ResearchStoredColumnWidths,
} from "../../lib/researchColumnWidths";
import {
  ResearchColumnResizer,
  ResearchColumnSizingContext,
  trimResearchStripSlack,
  type ResearchColumnSizing,
} from "./ResearchColumnResizer";

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
  /** Registers the handler for ⌃Tab / ⌃⇧Tab in the feed or in the open
   * document; returns the function that removes it. A handler returns false
   * when the request is not its own (the document's, when the column to
   * cycle is the feed). */
  registerCycle: (owner: ResearchCycleOwner, handler: ResearchCycleHandler) => () => void;
}

type ResearchCycleOwner = "feed" | "document";
type ResearchCycleHandler = (request: ResearchCycleRequest) => boolean;

export const ResearchColumnsContext = createContext<ResearchColumnsLayout | null>(null);

/** The column area: one horizontally scrolling strip with the feed column,
 * then the content (the open thread's column pairs, or a filler). Column
 * widths come from the area's width until a column's resize handle sets
 * them (researchColumnWidths.ts), and the strip scrolls sideways when the
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
  const [storedWidths, setStoredWidths] = useState<ResearchStoredColumnWidths>(loadResearchColumnWidths);

  useEffect(listenForInteraction, []);

  // ⌃Tab / ⌃⇧Tab select the next or previous row of the column last
  // interacted with: the last column in the strip that was focused, pressed
  // or typed in. Focus moving out of the strip (a menu, the sidebar) leaves
  // it as it was. The Home ask box handles ⌃Tab itself (it cycles the model
  // and the agent) and stops the event before it reaches this listener.
  const lastColumnRef = useRef<ResearchColumnId | null>(null);
  const cycleHandlersRef = useRef<Partial<Record<ResearchCycleOwner, ResearchCycleHandler>>>({});
  const registerCycle = useCallback((owner: ResearchCycleOwner, handler: ResearchCycleHandler) => {
    cycleHandlersRef.current[owner] = handler;
    return () => {
      if (cycleHandlersRef.current[owner] === handler) delete cycleHandlersRef.current[owner];
    };
  }, []);
  useEffect(() => {
    if (!row) return;
    const track = (event: Event) => {
      const id = columnIdOf(event.target instanceof Element ? event.target : null);
      if (id) lastColumnRef.current = id;
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const direction = researchCycleDirection(event);
      if (direction === null || event.defaultPrevented || event.isComposing) return;
      // The strip hidden behind another surface, or focus in a dialog or menu.
      if (!row.isConnected || row.getClientRects().length === 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role='dialog'], [role='alertdialog'], [role='menu'], .terminal-pane")) return;
      event.preventDefault();
      const request: ResearchCycleRequest = {
        column: lastColumnRef.current,
        direction,
        keepFocus: isEditableTarget(document.activeElement),
      };
      const handlers = cycleHandlersRef.current;
      if (!handlers.document?.(request)) handlers.feed?.(request);
    };
    row.addEventListener("pointerdown", track, true);
    row.addEventListener("keydown", track, true);
    row.addEventListener("focusin", track);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      row.removeEventListener("pointerdown", track, true);
      row.removeEventListener("keydown", track, true);
      row.removeEventListener("focusin", track);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [row]);

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

  // The feed's, the messages columns' and the answer columns' widths, each
  // automatic until its resize handle (ResearchColumnResizer) sets it.
  const setWidth = useCallback((kind: ResearchColumnWidthKind, width: number | null, persist: boolean) => {
    setStoredWidths((current) => (current[kind] === width ? current : { ...current, [kind]: width }));
    if (persist) saveResearchColumnWidth(kind, width);
  }, []);
  const sizing = useMemo<ResearchColumnSizing>(
    () => ({
      row,
      widths: shownResearchColumnWidths(storedWidths, availableWidth),
      automatic: researchColumnWidths(availableWidth),
      bounds: {
        feed: researchColumnWidthBounds("feed", availableWidth),
        turns: researchColumnWidthBounds("turns", availableWidth),
        answer: researchColumnWidthBounds("answer", availableWidth),
      },
      setWidth,
    }),
    [availableWidth, row, setWidth, storedWidths],
  );
  const widths = sizing.widths;

  // A resize can leave space after the last column, which kept the strip's
  // scroll offset in range; it shrinks as the strip scrolls back.
  useEffect(() => {
    if (!row) return;
    const onScroll = () => trimResearchStripSlack(row);
    row.addEventListener("scroll", onScroll, { passive: true });
    return () => row.removeEventListener("scroll", onScroll);
  }, [row]);

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
          // The messages-side columns (a level's messages, thread or pending
          // column, or a draft), left to right.
          const columns = [...(row?.querySelectorAll<HTMLElement>(columnSelector()) ?? [])].filter((element) =>
            isMessagesColumnId(element.dataset.researchColumn),
          );
          const column = deepest ? columns[columns.length - 1] : columns[0];
          const target = column?.querySelector<HTMLElement>(COLUMN_ROW_SELECTOR);
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
      registerCycle,
    }),
    [feedCurrent, overlay, registerCycle, row],
  );
  return (
    <ResearchColumnsContext.Provider value={layout}>
      <ResearchColumnSizingContext.Provider value={sizing}>
        <div
          ref={rootRef}
          className={`research-columns${hasDocument ? " has-document" : ""}`}
          style={
            {
              "--research-feed-column-width": `${widths.feed}px`,
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
                <ResearchColumnResizer kind="feed" label="Resize feed" />
              </section>
            ) : null}
            <div className="research-content-column">{children}</div>
            <div className="research-strip-slack" aria-hidden="true" />
          </div>
          <div ref={setOverlay} className="research-columns-overlay" />
        </div>
      </ResearchColumnSizingContext.Provider>
    </ResearchColumnsContext.Provider>
  );
}
