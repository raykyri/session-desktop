import { createContext, useContext } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { flushSync } from "react-dom";
import { columnSelector } from "../../lib/researchColumns";
import {
  researchColumnResize,
  researchColumnWidthKind,
  researchStripSlack,
  type ResearchColumnWidthKind,
  type ResearchColumnWidths,
} from "../../lib/researchColumnWidths";

/** The strip's column widths, for the resize handles. ResearchColumns
 * provides it. */
export interface ResearchColumnSizing {
  /** The horizontally scrolling strip. */
  row: HTMLElement | null;
  /** The width each kind of column is shown at. */
  widths: ResearchColumnWidths;
  bounds: Record<ResearchColumnWidthKind, { min: number; max: number }>;
  /** Sets a kind's width (null: the automatic width) and, with `persist`,
   * stores it. */
  setWidth: (kind: ResearchColumnWidthKind, width: number | null, persist: boolean) => void;
  /** The automatic widths, which a double-click returns to. */
  automatic: ResearchColumnWidths;
}

export const ResearchColumnSizingContext = createContext<ResearchColumnSizing | null>(null);

/** The strip's trailing space: an empty element after its last column. */
function slackElement(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(":scope > .research-strip-slack");
}

function stripSlack(row: HTMLElement): number {
  return parseFloat(slackElement(row)?.style.width ?? "") || 0;
}

function setStripSlack(row: HTMLElement, slack: number) {
  const element = slackElement(row);
  if (!element) return;
  if (slack > 0) element.style.width = `${slack}px`;
  else element.style.removeProperty("width");
}

/** Strips with a drag in progress. */
const dragging = new WeakSet<HTMLElement>();

/** Turns off transitions in the strip until the next frame, or until the
 * drag in progress ends. With Reduce motion on, every element has a
 * near-zero transition on every property (reduced-motion.css), which would
 * apply a new width a frame late, after the scroll offset that goes with it
 * was set. */
function suspendStripTransitions(row: HTMLElement) {
  row.classList.add("is-resizing");
  requestAnimationFrame(() => {
    if (!dragging.has(row)) row.classList.remove("is-resizing");
  });
}

/** The right edge of the strip's last column, in the strip's coordinates. */
function contentRight(row: HTMLElement): number {
  const columns = row.querySelectorAll<HTMLElement>(columnSelector());
  const last = columns[columns.length - 1];
  return last ? last.offsetLeft + last.offsetWidth : 0;
}

/** Drops the strip's trailing space down to what its scroll offset needs:
 * none once the view no longer reaches past the last column. Called after a
 * resize and while the strip scrolls. */
export function trimResearchStripSlack(row: HTMLElement) {
  const slack = stripSlack(row);
  if (slack <= 0) return;
  const needed = researchStripSlack(row.scrollLeft, row.clientWidth, contentRight(row));
  if (needed < slack) setStripSlack(row, needed);
}

/** How many columns left of `column` take their width from `kind`. */
function sharedColumnsBefore(row: HTMLElement, column: Element, kind: ResearchColumnWidthKind): number {
  if (kind === "feed") return 0;
  let count = 0;
  for (const element of row.querySelectorAll<HTMLElement>(columnSelector())) {
    if (element === column) break;
    if (researchColumnWidthKind(element.dataset.researchPair) === kind) count += 1;
  }
  return count;
}

/** How many columns in the strip take their width from `kind`. */
function sameKindColumns(row: HTMLElement, kind: ResearchColumnWidthKind): number {
  return [...row.querySelectorAll<HTMLElement>(columnSelector())].filter(
    (element) => researchColumnWidthKind(element.dataset.researchPair) === kind,
  ).length;
}

/** Applies a width and the scroll offset that goes with it in one task, so
 * no frame shows the strip with one and not the other. Before the columns
 * shrink, the strip gets trailing space enough that neither its current nor
 * its new scroll offset is past its end (the browser would otherwise clamp
 * the offset and the columns would jump); the space is trimmed to what the
 * new offset needs afterwards. */
function applyResize(
  sizing: ResearchColumnSizing,
  kind: ResearchColumnWidthKind,
  step: {
    /** The width to set; null for the automatic width. */
    width: number | null;
    /** The shown width before and after this step. */
    from: number;
    to: number;
    scrollLeft: number;
    persist: boolean;
  },
) {
  const row = sizing.row;
  if (row) {
    suspendStripTransitions(row);
    // The content's right edge after the change is at least this far right:
    // every column of the kind (left or right of the handle) changes by the
    // same amount.
    const changing = kind === "feed" ? 1 : sameKindColumns(row, kind);
    const lowest = contentRight(row) - changing * Math.abs(step.to - step.from);
    const scrollLeft = Math.max(row.scrollLeft, step.scrollLeft);
    setStripSlack(row, Math.max(stripSlack(row), researchStripSlack(scrollLeft, row.clientWidth, lowest)));
  }
  flushSync(() => sizing.setWidth(kind, step.width, step.persist));
  if (row) {
    if (Math.abs(row.scrollLeft - step.scrollLeft) >= 0.5) row.scrollLeft = step.scrollLeft;
    trimResearchStripSlack(row);
  }
}

/** The resize handle on a column's right edge: a vertical separator that
 * sets the width of every column of `kind`. Drag it, or press Left/Right
 * (with Shift for steps of 64px instead of 16px); a double-click returns
 * the width to automatic. Only that kind of column changes width, so the
 * columns right of the handle move with it and the resized column's left
 * edge stays where it is on screen. `belowHeader` starts the handle below
 * the column header, for a messages column whose header spans its pair. */
export function ResearchColumnResizer({
  kind,
  label,
  belowHeader = false,
}: {
  kind: ResearchColumnWidthKind;
  label: string;
  belowHeader?: boolean;
}) {
  const sizing = useContext(ResearchColumnSizingContext);
  if (!sizing) return null;
  const { min, max } = sizing.bounds[kind];
  const shown = sizing.widths[kind];

  const resizeFrom = (handle: HTMLElement) => {
    const row = sizing.row;
    const column = handle.closest(columnSelector());
    return {
      startWidth: sizing.widths[kind],
      startScrollLeft: row?.scrollLeft ?? 0,
      sharedBefore: row && column ? sharedColumnsBefore(row, column, kind) : 0,
    };
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const start = resizeFrom(handle);
    const startX = event.clientX;
    const row = sizing.row;
    if (row) dragging.add(row);
    let lastWidth = start.startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: globalThis.PointerEvent) => {
      const next = researchColumnResize({ ...start, delta: moveEvent.clientX - startX, min, max });
      if (next.width === lastWidth) return;
      const from = lastWidth;
      lastWidth = next.width;
      applyResize(sizing, kind, {
        width: next.width,
        from,
        to: next.width,
        scrollLeft: next.scrollLeft,
        persist: false,
      });
    };
    const stop = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (row) {
        dragging.delete(row);
        row.classList.remove("is-resizing");
      }
      if (lastWidth !== start.startWidth) sizing.setWidth(kind, lastWidth, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = (event.shiftKey ? 64 : 16) * (event.key === "ArrowRight" ? 1 : -1);
    const start = resizeFrom(event.currentTarget);
    const next = researchColumnResize({ ...start, delta: step, min, max });
    if (next.width === start.startWidth) return;
    applyResize(sizing, kind, {
      width: next.width,
      from: start.startWidth,
      to: next.width,
      scrollLeft: next.scrollLeft,
      persist: true,
    });
  };

  const reset = (event: MouseEvent<HTMLDivElement>) => {
    const { startWidth, startScrollLeft, sharedBefore } = resizeFrom(event.currentTarget);
    const width = sizing.automatic[kind];
    const scrollLeft = Math.max(0, startScrollLeft + sharedBefore * (width - startWidth));
    applyResize(sizing, kind, { width: null, from: startWidth, to: width, scrollLeft, persist: true });
  };

  return (
    <div
      className={`research-column-resizer${belowHeader ? " is-below-header" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={reset}
    />
  );
}
