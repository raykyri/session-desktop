// The resize handle on a column's right edge, ported from the desktop
// `ResearchColumnResizer.tsx`: a vertical separator that sets the width of
// every column of its kind. Drag it, or press ←/→ (with Shift for 64px steps
// instead of 16px); a double-click returns the width to automatic. The strip
// scrolls with the change so the resized column's left edge stays where it is
// on screen.

import { columnSelector } from "@session/shared/lib/researchColumns";
import { useContext } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { flushSync } from "react-dom";

import { cn } from "../../lib/cn.js";

import { ColumnSizingContext, type ColumnSizing } from "./Columns.js";
import { columnResize, columnWidthKind, type ColumnWidthKind } from "./columnWidths.js";

/** How many columns left of `column` take their width from `kind`. */
function sharedColumnsBefore(row: HTMLElement, column: Element, kind: ColumnWidthKind): number {
  let count = 0;
  for (const element of row.querySelectorAll<HTMLElement>(columnSelector())) {
    if (element === column) break;
    if (columnWidthKind(element.dataset["researchPair"]) === kind) count += 1;
  }
  return count;
}

function applyResize(
  sizing: ColumnSizing,
  kind: ColumnWidthKind,
  width: number | null,
  scrollLeft: number,
  persist: boolean,
) {
  flushSync(() => sizing.setWidth(kind, width, persist));
  const row = sizing.row;
  if (row && Math.abs(row.scrollLeft - scrollLeft) >= 0.5) row.scrollLeft = scrollLeft;
}

export function ColumnResizer({
  kind,
  label,
  belowHeader = false,
}: {
  kind: ColumnWidthKind;
  label: string;
  /** Starts the handle below the header, for a messages column whose header
   * spans its pair. */
  belowHeader?: boolean;
}) {
  const sizing = useContext(ColumnSizingContext);
  if (!sizing) return null;
  const { min, max } = sizing.bounds[kind];

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
    handle.setPointerCapture?.(pointerId);
    const start = resizeFrom(handle);
    const startX = event.clientX;
    let last = start.startWidth;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: globalThis.PointerEvent) => {
      const next = columnResize({ ...start, delta: moveEvent.clientX - startX, min, max });
      if (next.width === last) return;
      last = next.width;
      applyResize(sizing, kind, next.width, next.scrollLeft, false);
    };
    const stop = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      if (last !== start.startWidth) sizing.setWidth(kind, last, true);
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
    const next = columnResize({ ...start, delta: step, min, max });
    if (next.width !== start.startWidth) {
      applyResize(sizing, kind, next.width, next.scrollLeft, true);
    }
  };

  const reset = (event: MouseEvent<HTMLDivElement>) => {
    const { startWidth, startScrollLeft, sharedBefore } = resizeFrom(event.currentTarget);
    const width = sizing.automatic[kind];
    const scrollLeft = Math.max(0, startScrollLeft + sharedBefore * (width - startWidth));
    applyResize(sizing, kind, null, scrollLeft, true);
  };

  // A focusable separator is a widget (WAI-ARIA window splitter): it takes
  // the pointer and the arrow keys.
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={cn(
        "absolute right-[-4px] bottom-0 z-[3] w-2 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-transparent",
        "hover:after:bg-accent focus-visible:after:bg-accent",
        belowHeader ? "top-(--research-header-height,43px)" : "top-0",
      )}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={sizing.widths[kind]}
      title="Drag to resize · double-click to reset"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={reset}
    />
  );
}
