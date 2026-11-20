// Aligns the app bar with the feed's columns (02 §2.2 "Placement"; the
// mock's `alignBar`). In layout `centred` above 860 px the bar is a floating
// card:
// - above 1320 px the main column is centred on its own, so the bar takes
//   the main column's left edge and width;
// - from 861 to 1320 px the main and side columns are centred as a pair, so
//   the bar spans from the main column's left edge to the side column's
//   right edge.
// In layout `wide`, at 860 px and below and on screens that are not feeds
// the bar is full width.
//
// The columns are measured on the first feed row whose first cell is not a
// channel header (`data-row-head`), relative to the shell.

import { useLayoutEffect, useState } from "react";

import type { FeedLayout } from "../../stores/navigation.js";

/** At this width and below the feed is one column and the bar full width. */
export const ONE_COLUMN_MAX = 860;
/** Above this width the main column is centred on its own. */
export const MAIN_ONLY_MIN = 1321;

export interface BarAlignment {
  /** Left edge relative to the shell, px. */
  left: number;
  width: number;
}

interface Box {
  left: number;
  right: number;
}

/** The bar's box from the shell's box and the measured columns, or null for a
 * full-width bar. Pure, for tests. */
export function barAlignment(input: {
  layout: FeedLayout;
  isFeed: boolean;
  viewportWidth: number;
  shell: Box;
  main: Box | null;
  side: Box | null;
}): BarAlignment | null {
  const { layout, isFeed, viewportWidth, shell, main, side } = input;
  if (!isFeed || layout !== "centred" || viewportWidth <= ONE_COLUMN_MAX || !main) return null;
  const right = viewportWidth < MAIN_ONLY_MIN && side ? side.right : main.right;
  return { left: main.left - shell.left, width: right - main.left };
}

/** The main and side cells of the first feed row that is not a header row. */
export function feedColumns(root: ParentNode): { main: Element; side: Element | null } | null {
  for (const row of root.querySelectorAll(".feed-row")) {
    const first = row.firstElementChild;
    if (first && !first.hasAttribute("data-row-head")) {
      return { main: first, side: first.nextElementSibling };
    }
  }
  return null;
}

function sameAlignment(a: BarAlignment | null, b: BarAlignment | null): boolean {
  return a === b || (a !== null && b !== null && a.left === b.left && a.width === b.width);
}

/**
 * Measures after every render that changes the layout, the screen or the
 * rows, and on resize: `ResizeObserver` on the scroll container catches the
 * viewport and the scrollbar, `MutationObserver` catches rows mounting.
 */
export function useBarAlign(
  shell: HTMLElement | null,
  scrollEl: HTMLElement | null,
  layout: FeedLayout,
  isFeed: boolean,
): BarAlignment | null {
  const [alignment, setAlignment] = useState<BarAlignment | null>(null);

  useLayoutEffect(() => {
    if (!shell || !scrollEl) return;
    const measure = () => {
      const columns = isFeed ? feedColumns(scrollEl) : null;
      const next = barAlignment({
        layout,
        isFeed,
        viewportWidth: window.innerWidth,
        shell: shell.getBoundingClientRect(),
        main: columns ? columns.main.getBoundingClientRect() : null,
        side: columns?.side ? columns.side.getBoundingClientRect() : null,
      });
      setAlignment((current) => (sameAlignment(current, next) ? current : next));
    };
    measure();
    // Observers fire often while a feed renders; one measurement per frame.
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    window.addEventListener("resize", schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(scrollEl);
    const mutation = new MutationObserver(schedule);
    mutation.observe(scrollEl, { childList: true, subtree: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [shell, scrollEl, layout, isFeed]);

  return alignment;
}
