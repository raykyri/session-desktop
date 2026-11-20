// The horizontally scrolling strip a thread's columns sit in
// (`09-research-document-view.md` §2), ported from the desktop
// `ResearchColumns.tsx` without its feed column: on the web, Home is a route
// of its own, so the strip holds only the open thread's columns.
//
// The strip owns the column widths (automatic until a resize handle sets
// them), the shared header height, horizontal wheel scrolling over columns
// that scroll only vertically, and the ⌃Tab dispatch to the thread page.

import {
  researchCycleDirection,
  type ResearchCycleRequest,
} from "@session/shared/lib/researchSiblingCycle";
import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  columnWidthBounds,
  columnWidths,
  loadColumnWidths,
  saveColumnWidth,
  shownColumnWidths,
  type ColumnWidthKind,
  type ColumnWidths,
  type StoredColumnWidths,
} from "./columnWidths.js";
import { columnIdOf, listenForInteraction } from "./stripDom.js";
import { isEditableEventTarget } from "./textRanges.js";

type CycleHandler = (request: ResearchCycleRequest) => boolean;

export interface ColumnsLayout {
  /** The horizontally scrolling strip. */
  row: HTMLElement | null;
  /** A fixed layer above the strip for the find bar. */
  overlay: HTMLElement | null;
  /** Registers the thread page's ⌃Tab handler; returns its removal. */
  registerCycle: (handler: CycleHandler) => () => void;
}

export const ColumnsLayoutContext = createContext<ColumnsLayout | null>(null);

/** The widths the resize handles read and set. */
export interface ColumnSizing {
  row: HTMLElement | null;
  widths: ColumnWidths;
  automatic: ColumnWidths;
  bounds: Record<ColumnWidthKind, { min: number; max: number }>;
  setWidth: (kind: ColumnWidthKind, width: number | null, persist: boolean) => void;
}

export const ColumnSizingContext = createContext<ColumnSizing | null>(null);

/** The minimum header height: one line of title in the 43px bar. */
const MIN_HEADER_HEIGHT = 43;

export function Columns({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(1232);
  const [stored, setStored] = useState<StoredColumnWidths>(loadColumnWidths);

  useEffect(listenForInteraction, []);

  // ⌃Tab / ⌃⇧Tab cycle the rows of the column last interacted with (pressed,
  // focused or typed in). Focus leaving the strip keeps the last column.
  const lastColumnRef = useRef<ReturnType<typeof columnIdOf>>(null);
  const cycleRef = useRef<CycleHandler | null>(null);
  const registerCycle = useCallback((handler: CycleHandler) => {
    cycleRef.current = handler;
    return () => {
      if (cycleRef.current === handler) cycleRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (!row) return;
    const track = (event: Event) => {
      const id = columnIdOf(event.target instanceof Element ? event.target : null);
      if (id) lastColumnRef.current = id;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = researchCycleDirection(event);
      if (direction === null || event.defaultPrevented || event.isComposing) return;
      if (!row.isConnected) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role='dialog'], [role='alertdialog'], [role='menu']")) return;
      event.preventDefault();
      cycleRef.current?.({
        column: lastColumnRef.current,
        direction,
        keepFocus: isEditableEventTarget(document.activeElement),
      });
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
    const measure = () => setAvailableWidth(root.clientWidth || 1232);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Mostly horizontal wheel input (and Shift+wheel) scrolls the strip, even
  // over a column that scrolls only vertically. A wide table or code block
  // that can still scroll that way keeps the input.
  useEffect(() => {
    if (!row) return;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? row.clientWidth : 1;
      let dx = event.deltaX;
      let dy = event.deltaY;
      if (event.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      if (!dx || Math.abs(dx) <= Math.abs(dy)) return;
      for (
        let element = event.target instanceof Element ? event.target : null;
        element && element !== row;
        element = element.parentElement
      ) {
        if (element.scrollWidth - element.clientWidth <= 1) continue;
        const overflowX = getComputedStyle(element).overflowX;
        if (overflowX !== "auto" && overflowX !== "scroll") continue;
        if (
          (dx < 0 && element.scrollLeft > 0) ||
          (dx > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth - 1)
        ) {
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

  // Every column header takes the height of the tallest wrapped title.
  useEffect(() => {
    if (!row || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const bars = [...row.querySelectorAll<HTMLElement>("[data-research-header-bar]")];
      const tallest = Math.max(MIN_HEADER_HEIGHT, ...bars.map((bar) => bar.offsetHeight));
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

  const setWidth = useCallback((kind: ColumnWidthKind, width: number | null, persist: boolean) => {
    setStored((current) => (current[kind] === width ? current : { ...current, [kind]: width }));
    if (persist) saveColumnWidth(kind, width);
  }, []);
  const sizing = useMemo<ColumnSizing>(
    () => ({
      row,
      widths: shownColumnWidths(stored, availableWidth),
      automatic: columnWidths(availableWidth),
      bounds: { messages: columnWidthBounds("messages"), answer: columnWidthBounds("answer") },
      setWidth,
    }),
    [availableWidth, row, setWidth, stored],
  );
  const layout = useMemo<ColumnsLayout>(
    () => ({ row, overlay, registerCycle }),
    [overlay, registerCycle, row],
  );
  const widths = sizing.widths;

  return (
    <ColumnsLayoutContext.Provider value={layout}>
      <ColumnSizingContext.Provider value={sizing}>
        <div
          ref={rootRef}
          className="research-columns bg-surface-research relative h-full min-w-0 overflow-hidden"
          style={
            {
              "--research-messages-width": `${widths.messages}px`,
              "--research-answer-width": `${widths.answer}px`,
            } as CSSProperties
          }
        >
          <div
            ref={setRow}
            className="research-columns-row flex h-full min-w-0 [scrollbar-width:thin] overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            {children}
          </div>
          <div
            ref={setOverlay}
            className="pointer-events-none absolute inset-x-0 top-0 z-10 [&>*]:pointer-events-auto"
          />
        </div>
      </ColumnSizingContext.Provider>
    </ColumnsLayoutContext.Provider>
  );
}
