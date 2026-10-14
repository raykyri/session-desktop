import { useEffect, useRef, type RefObject } from "react";
import {
  researchSwipeDirection,
  researchSwipeTailCapturesWheel,
} from "@session/shared/lib/researchHistory";

const RESEARCH_SWIPE_IDLE_MS = 180;
// Ignore tiny startup jitter, but reserve a clearly vertical gesture for
// scrolling well before it can reach the history-navigation threshold.
const RESEARCH_SCROLL_INTENT_PX = 16;

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

/** Whether the wheel target is inside an element that scrolls sideways: the
 * column strip when its columns don't fit, a wide table or code block. A
 * horizontal gesture there scrolls it; reaching its edge must not turn the
 * rest of the gesture (or the next flick) into back/forward navigation. */
function insideHorizontalScroller(target: EventTarget | null): boolean {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    if (element instanceof HTMLElement && element.scrollWidth - element.clientWidth > 1) {
      const overflowX = getComputedStyle(element).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") {
        return true;
      }
    }
  }
  return false;
}

/** Adds trackpad back/forward navigation gestures to a research scroller.
 * Gestures over anything that scrolls sideways (see insideHorizontalScroller)
 * scroll it instead and never navigate. */
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
    let horizontalTravel = 0;
    let verticalTravel = 0;
    let scrolling = false;
    let blockedByScroller = false;
    let resetTimer: number | null = null;
    const resetGesture = () => {
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
      accumulatedX = 0;
      horizontalTravel = 0;
      verticalTravel = 0;
      scrolling = false;
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
        if (researchSwipeTailCapturesWheel(deltaX, deltaY)) {
          event.preventDefault();
        }
        return;
      }
      scheduleReset();
      if (scrolling) {
        return;
      }
      accumulatedX += deltaX;
      horizontalTravel += Math.abs(deltaX);
      verticalTravel += Math.abs(deltaY);
      // Reversing vertical direction must not erase scrolling intent. Once
      // established, keep it until idle, even if later momentum is horizontal.
      if (verticalTravel >= RESEARCH_SCROLL_INTENT_PX && verticalTravel > horizontalTravel * 1.25) {
        scrolling = true;
        return;
      }
      const direction = researchSwipeDirection(accumulatedX, verticalTravel);
      if (direction === 0) {
        return;
      }
      // Do not consume a gesture when history cannot move in that direction.
      const navigate = direction < 0 ? onBackRef.current : onForwardRef.current;
      if (!navigate) {
        return;
      }
      event.preventDefault();
      holdNavigatedGesture();
      navigate();
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
