// Trackpad back/forward inside a document (`09-research-document-view.md` §6).
//
// Ported from the desktop hook. Three details carry the behavior: the listener
// is non-passive because a recognized swipe has to `preventDefault` before the
// browser starts its own back gesture; deltas are scaled out of their
// `deltaMode` so a line- or page-mode wheel is measured in the same pixels as a
// trackpad's; and a nested horizontal scroller (a wide table, a code block)
// that can still scroll keeps the gesture, because that is what the reader
// meant by it.
//
// The momentum latch is module-level rather than per-hook: a completed swipe
// swaps the page, which unmounts this scroller and mounts another, and the
// residual momentum would otherwise land on the new one and navigate twice.

import { researchSwipeDirection, researchSwipeTailCapturesWheel } from "@session/shared";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const RESEARCH_SWIPE_IDLE_MS = 180;

let gestureNavigated = false;
let gestureIdleTimer: ReturnType<typeof setTimeout> | null = null;

function extendNavigatedGesture(): void {
  if (gestureIdleTimer !== null) clearTimeout(gestureIdleTimer);
  gestureIdleTimer = setTimeout(() => {
    gestureIdleTimer = null;
    gestureNavigated = false;
  }, RESEARCH_SWIPE_IDLE_MS);
}

function holdNavigatedGesture(): void {
  gestureNavigated = true;
  extendNavigatedGesture();
}

function horizontalScrollerConsumesWheel(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaX: number,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== boundary && boundary.contains(element)) {
    if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth) {
      const { overflowX } = getComputedStyle(element);
      if (overflowX === "auto" || overflowX === "scroll") {
        const canScrollLeft = deltaX < 0 && element.scrollLeft > 0;
        const canScrollRight =
          deltaX > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth;
        if (canScrollLeft || canScrollRight) return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

export function useResearchSwipeNavigation(
  targetRef: RefObject<HTMLElement | null>,
  onBack: () => void,
  onForward: () => void,
  attachmentKey?: unknown,
): void {
  // Latest-callback refs: the wheel listener is non-passive and re-attaching
  // it on every render would drop an in-flight gesture.
  const backRef = useRef(onBack);
  const forwardRef = useRef(onForward);
  useEffect(() => {
    backRef.current = onBack;
    forwardRef.current = onForward;
  });

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let accumulatedX = 0;
    let accumulatedY = 0;
    let blockedByScroller = false;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    const resetGesture = () => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      accumulatedX = 0;
      accumulatedY = 0;
      blockedByScroller = false;
      resetTimer = null;
    };
    const scheduleReset = () => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = setTimeout(resetGesture, RESEARCH_SWIPE_IDLE_MS);
    };

    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? target.clientWidth
            : 1;
      const deltaX = event.deltaX * scale;
      const deltaY = event.deltaY * scale;
      if (horizontalScrollerConsumesWheel(event.target, target, deltaX)) {
        blockedByScroller = true;
        scheduleReset();
        return;
      }
      if (blockedByScroller) {
        scheduleReset();
        return;
      }
      if (gestureNavigated) {
        extendNavigatedGesture();
        if (researchSwipeTailCapturesWheel(deltaX, deltaY)) event.preventDefault();
        return;
      }
      scheduleReset();
      accumulatedX += deltaX;
      accumulatedY += deltaY;
      const direction = researchSwipeDirection(accumulatedX, accumulatedY);
      if (direction === 0) return;
      event.preventDefault();
      holdNavigatedGesture();
      if (direction < 0) backRef.current();
      else forwardRef.current();
    };

    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", onWheel);
      if (resetTimer !== null) clearTimeout(resetTimer);
    };
  }, [attachmentKey, targetRef]);
}
