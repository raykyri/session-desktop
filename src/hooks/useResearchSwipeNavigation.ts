import { useEffect, useRef, type RefObject } from "react";
import {
  researchSwipeDirection,
  researchSwipeTailCapturesWheel,
} from "../lib/researchHistory";

const RESEARCH_SWIPE_IDLE_MS = 180;

// Prevent residual swipe momentum from triggering a second navigation when the
// scroller element swaps mid-gesture.
let gestureNavigated = false;
let gestureIdleTimer: number | null = null;

function extendNavigatedGesture() {
  if (gestureIdleTimer !== null) {
    window.clearTimeout(gestureIdleTimer);
  }
  gestureIdleTimer = window.setTimeout(() => {
    gestureIdleTimer = null;
    gestureNavigated = false;
  }, RESEARCH_SWIPE_IDLE_MS);
}

function holdNavigatedGesture() {
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
      const overflowX = getComputedStyle(element).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") {
        const canScrollLeft = deltaX < 0 && element.scrollLeft > 0;
        const canScrollRight =
          deltaX > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth;
        if (canScrollLeft || canScrollRight) {
          return true;
        }
      }
    }
    element = element.parentElement;
  }
  return false;
}

/** Adds trackpad back/forward navigation gestures to a research scroller. */
export function useResearchSwipeNavigation(
  targetRef: RefObject<HTMLElement | null>,
  onBack: (() => void) | undefined,
  onForward: (() => void) | undefined,
  attachmentKey?: unknown,
) {
  const onBackRef = useRef(onBack);
  const onForwardRef = useRef(onForward);
  onBackRef.current = onBack;
  onForwardRef.current = onForward;

  useEffect(() => {
    const target = targetRef.current;
    if (!target) {
      return;
    }
    let accumulatedX = 0;
    let accumulatedY = 0;
    let blockedByScroller = false;
    let resetTimer: number | null = null;
    const resetGesture = () => {
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
      accumulatedX = 0;
      accumulatedY = 0;
      blockedByScroller = false;
      resetTimer = null;
    };
    const scheduleReset = () => {
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
      resetTimer = window.setTimeout(resetGesture, RESEARCH_SWIPE_IDLE_MS);
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
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
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
      // Consume residual horizontal momentum from the completed swipe.
      if (gestureNavigated) {
        extendNavigatedGesture();
        if (researchSwipeTailCapturesWheel(deltaX, deltaY)) {
          event.preventDefault();
        }
        return;
      }
      scheduleReset();
      accumulatedX += deltaX;
      accumulatedY += deltaY;
      const direction = researchSwipeDirection(accumulatedX, accumulatedY);
      if (direction === 0) {
        return;
      }
      event.preventDefault();
      holdNavigatedGesture();
      if (direction < 0) {
        onBackRef.current?.();
      } else {
        onForwardRef.current?.();
      }
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", onWheel);
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
    };
  }, [attachmentKey, targetRef]);
}
