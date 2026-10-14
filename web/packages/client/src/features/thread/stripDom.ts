// DOM helpers for the column strip of a thread (`09-research-document-view.md`
// §2). The strip's model is the shared `researchColumns` module, which has no
// DOM access; this module finds column elements and scrolls the strip and its
// columns. Ported from the desktop `ResearchColumns.tsx` helpers and
// `researchColumnDom.ts`.

import {
  columnSelector,
  researchStripSettleLeft,
  type ResearchColumnId,
} from "@session/shared/lib/researchColumns";

/** The id of the column that holds `element`, or null outside the strip. */
export function columnIdOf(element: Element | null | undefined): ResearchColumnId | null {
  const id = element?.closest<HTMLElement>(columnSelector())?.dataset["researchColumn"];
  return id && /^(feed|placeholder|[TANE]\d+)$/.test(id) ? (id as ResearchColumnId) : null;
}

/** The system's reduced-motion preference. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Scrolling is immediate until the first pointer, key or wheel input, so
// opening or restoring a thread sets its positions without animation.
let interacted = false;
let listening = false;

/** Starts tracking the first input, once per page. */
export function listenForInteraction(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
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

export function stripScrollBehavior(): ScrollBehavior {
  return interacted && !prefersReducedMotion() ? "smooth" : "auto";
}

/** Scrolls the strip the least distance that shows `first` through `last`;
 * when they are wider than the strip, `first` is aligned to its left edge. */
export function revealColumns(
  row: HTMLElement | null,
  first: HTMLElement | null,
  last: HTMLElement | null = first,
  behavior: ScrollBehavior = stripScrollBehavior(),
): void {
  if (!row || !first || !last) return;
  const viewLeft = row.scrollLeft;
  const viewWidth = row.clientWidth;
  const left = first.offsetLeft;
  const right = last.offsetLeft + last.offsetWidth;
  if (left >= viewLeft - 1 && right <= viewLeft + viewWidth + 1) return;
  const target = right - left > viewWidth || left < viewLeft ? left : right - viewWidth;
  if (typeof row.scrollTo === "function") row.scrollTo({ left: target, behavior });
  else row.scrollLeft = target;
}

/** Aligns the strip's last column to its right edge after a level changes,
 * then shifts it the least distance that keeps `focusId` in view. With
 * `skipPending`, a branches column holding only an unsent branch is not the
 * last column (see researchStripSettleLeft). */
export function settleStrip(
  row: HTMLElement | null,
  focusId: ResearchColumnId | null,
  behavior: ScrollBehavior = stripScrollBehavior(),
  skipPending = false,
): void {
  if (!row) return;
  const columns = [...row.querySelectorAll<HTMLElement>(columnSelector())].map((element) => ({
    id: element.dataset["researchColumn"] ?? "",
    left: element.offsetLeft,
    width: element.offsetWidth,
    pendingOnly: element.hasAttribute("data-research-pending-only"),
  }));
  const left = researchStripSettleLeft(columns, row.clientWidth, focusId, skipPending);
  if (left === null || Math.abs(row.scrollLeft - left) <= 1) return;
  if (typeof row.scrollTo === "function") row.scrollTo({ left, behavior });
  else row.scrollLeft = left;
}

/** Brings `element` (a row, or the row it sits in) fully into its column; a
 * row taller than the column scrolls its top to the column's top. */
export function scrollIntoColumn(element: Element, behavior: ScrollBehavior = "auto"): void {
  const scroller = element.closest<HTMLElement>("[data-research-scroll]");
  if (!scroller) return;
  const target = element.closest(".research-msg-row") ?? element;
  const rect = target.getBoundingClientRect();
  const bounds = scroller.getBoundingClientRect();
  let delta = 0;
  if (rect.height > bounds.height || rect.top < bounds.top) delta = rect.top - bounds.top;
  else if (rect.bottom > bounds.bottom) delta = rect.bottom - bounds.bottom;
  if (!delta) return;
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
  } else {
    scroller.scrollTop += delta;
  }
}

/** `CSS.escape` where the engine has it (jsdom may not), else a quoting
 * fallback: node ids are server strings, so selectors built from them are
 * escaped. */
export function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** The selector of a message row's selection button. */
export function rowSelector(nodeId: string): string {
  return `[data-research-row][data-node-id="${cssEscape(nodeId)}"]`;
}

/** The scroll container of a column element. */
export function columnScroller(column: Element | null | undefined): HTMLElement | null {
  return column?.querySelector<HTMLElement>(":scope > [data-research-scroll]") ?? null;
}
