// Trackpad back/forward on the thread page, ported from the desktop
// `useResearchSwipeNavigation`: a horizontal two-finger swipe past the
// threshold (`researchSwipeDirection`) goes back or forward in the thread's
// history (`useThreadHistory`, the browser's history of `?sel=`). A gesture
// over anything that scrolls sideways (the strip when its columns do not fit,
// a wide table or code block) scrolls it and never navigates, also when it
// reaches that element's edge. The momentum left after a navigation is
// consumed, so one swipe moves one step.
//
// While the hook is attached, the document's own horizontal overscroll is
// turned off (`overscroll-behavior-x: none` on the root element) so the
// browser's swipe navigation does not run as well; a browser that ignores
// that property (Safari's system gesture) can still navigate on its own.

import {
  researchSwipeDirection,
  researchSwipeTailCapturesWheel,
} from "@session/shared/lib/researchHistory";
import { useEffect } from "react";

import { useLatest } from "./useLatest.js";

const SWIPE_IDLE_MS = 180;
// Ignore tiny startup jitter, but reserve a clearly vertical gesture for
// scrolling well before it can reach the history-navigation threshold.
const SCROLL_INTENT_PX = 16;

// Residual swipe momentum must not trigger a second navigation when the
// target element is replaced mid-gesture.
let gestureNavigated = false;
let gestureIdleTimer: ReturnType<typeof setTimeout> | null = null;

function extendNavigatedGesture() {
  if (gestureIdleTimer !== null) clearTimeout(gestureIdleTimer);
  gestureIdleTimer = setTimeout(() => {
    gestureIdleTimer = null;
    gestureNavigated = false;
  }, SWIPE_IDLE_MS);
}

function holdNavigatedGesture() {
  gestureNavigated = true;
  extendNavigatedGesture();
}

/** Whether the wheel target is inside an element that scrolls sideways. */
export function insideHorizontalScroller(target: EventTarget | null): boolean {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    if (element instanceof HTMLElement && element.scrollWidth - element.clientWidth > 1) {
      const overflowX = getComputedStyle(element).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
  }
  return false;
}

/** Attaches the gesture to `targetRef`'s element. `onBack` / `onForward`
 * are absent when history cannot move that way, and the gesture is then left
 * alone. `attachmentKey` re-attaches the listener when the element changes
 * (the placeholder is replaced by the columns). */
export function useSwipeNavigation(
  targetRef: { readonly current: HTMLElement | null },
  onBack: (() => void) | undefined,
  onForward: (() => void) | undefined,
  attachmentKey?: unknown,
) {
  const handlers = useLatest({ onBack, onForward });

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const root = document.documentElement;
    const previousOverscroll = root.style.overscrollBehaviorX;
    root.style.overscrollBehaviorX = "none";
    let accumulatedX = 0;
    let horizontalTravel = 0;
    let verticalTravel = 0;
    let scrolling = false;
    let blockedByScroller = false;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    const resetGesture = () => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      accumulatedX = 0;
      horizontalTravel = 0;
      verticalTravel = 0;
      scrolling = false;
      blockedByScroller = false;
      resetTimer = null;
    };
    const scheduleReset = () => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = setTimeout(resetGesture, SWIPE_IDLE_MS);
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
            ? target.clientWidth || window.innerWidth
            : 1;
      const deltaX = event.deltaX * scale;
      const deltaY = event.deltaY * scale;
      if (insideHorizontalScroller(event.target)) {
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
        if (researchSwipeTailCapturesWheel(deltaX, deltaY)) event.preventDefault();
        return;
      }
      scheduleReset();
      if (scrolling) return;
      accumulatedX += deltaX;
      horizontalTravel += Math.abs(deltaX);
      verticalTravel += Math.abs(deltaY);
      // Reversing vertical direction must not erase scrolling intent. Once
      // established, keep it until idle, even if later momentum is horizontal.
      if (verticalTravel >= SCROLL_INTENT_PX && verticalTravel > horizontalTravel * 1.25) {
        scrolling = true;
        return;
      }
      const direction = researchSwipeDirection(accumulatedX, verticalTravel);
      if (direction === 0) return;
      // A gesture history cannot follow is left to the page.
      const navigate = direction < 0 ? handlers.current.onBack : handlers.current.onForward;
      if (!navigate) return;
      event.preventDefault();
      holdNavigatedGesture();
      navigate();
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", onWheel);
      if (resetTimer !== null) clearTimeout(resetTimer);
      root.style.overscrollBehaviorX = previousOverscroll;
    };
  }, [attachmentKey, handlers, targetRef]);
}

/** Test seam: clears a navigated gesture's momentum. */
export function resetSwipeGestureForTests(): void {
  if (gestureIdleTimer !== null) clearTimeout(gestureIdleTimer);
  gestureIdleTimer = null;
  gestureNavigated = false;
}
