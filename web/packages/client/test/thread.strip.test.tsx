// The thread page's strip hooks ported from the desktop
// (`09-research-document-view.md` §4): a commit puts the strip back at its
// horizontal position (`useFocusRequests`), and a trackpad swipe goes back
// or forward (`useSwipeNavigation`).

import { act, cleanup, render } from "@testing-library/react";
import test from "ava";
import { useLayoutEffect, useRef } from "react";

import { useFocusRequests } from "../src/features/thread/useFocusRequests.js";
import {
  resetSwipeGestureForTests,
  useSwipeNavigation,
} from "../src/features/thread/useSwipeNavigation.js";

test.afterEach.always(() => {
  cleanup();
  resetSwipeGestureForTests();
});

/** jsdom does not scroll: a strip whose `scrollLeft` is a plain value. */
function scrollable(element: HTMLElement, width = { scroll: 2000, client: 800 }): void {
  let left = 0;
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = value;
    },
  });
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: width.scroll });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width.client });
}

/* ------------------------------------------------------ strip position */

/** A column whose commit moves the strip, as a layout change can. Children's
 * layout effects run before the page's, as the columns' do. */
function MovesStrip({ strip, tick }: { strip: () => HTMLElement | null; tick: number }) {
  useLayoutEffect(() => {
    const element = strip();
    if (element && tick > 0) element.scrollLeft = 0;
  }, [strip, tick]);
  return null;
}

function StripPage({ tick }: { tick: number }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  useFocusRequests({
    rowRef,
    workspaceRef,
    composerField: () => null,
    editorField: () => null,
  });
  return (
    <div ref={workspaceRef}>
      <div
        ref={(element) => {
          rowRef.current = element;
          if (element && !Object.getOwnPropertyDescriptor(element, "scrollLeft")) {
            scrollable(element);
          }
        }}
        data-testid="strip"
      />
      <MovesStrip strip={() => rowRef.current} tick={tick} />
    </div>
  );
}

test.serial("a re-render puts the strip back where it was", (t) => {
  const { getByTestId, rerender } = render(<StripPage tick={0} />);
  const strip = getByTestId("strip");
  strip.scrollLeft = 640;
  act(() => rerender(<StripPage tick={1} />));
  t.is(strip.scrollLeft, 640);
});

/* ----------------------------------------------------- swipe navigation */

function SwipePage({
  onBack,
  onForward,
  wide = false,
}: {
  onBack?: () => void;
  onForward?: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useSwipeNavigation(ref, onBack, onForward);
  return (
    <div ref={ref} data-testid="page">
      <div
        data-testid="wide"
        style={{ overflowX: "auto" }}
        ref={(element) => {
          if (element && wide) scrollable(element);
        }}
      >
        <span data-testid="text">Text</span>
      </div>
    </div>
  );
}

function wheel(target: Element, deltaX: number, deltaY = 0): boolean {
  const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

test.serial("a horizontal swipe goes back once, and its momentum is consumed", (t) => {
  let back = 0;
  let forward = 0;
  const { getByTestId } = render(
    <SwipePage onBack={() => (back += 1)} onForward={() => (forward += 1)} />,
  );
  t.is(document.documentElement.style.overscrollBehaviorX, "none");
  const text = getByTestId("text");
  let prevented = false;
  for (let step = 0; step < 12; step += 1) prevented = wheel(text, -20) || prevented;
  t.is(back, 1);
  t.is(forward, 0);
  t.true(prevented);
  // Right after the swipe, more horizontal momentum is swallowed.
  t.true(wheel(text, -20));
  t.is(back, 1);
  cleanup();
  t.is(document.documentElement.style.overscrollBehaviorX, "");
});

test.serial("a vertical scroll and a swipe history cannot follow are left alone", (t) => {
  let forward = 0;
  const { getByTestId } = render(<SwipePage onForward={() => (forward += 1)} />);
  const text = getByTestId("text");
  for (let step = 0; step < 12; step += 1) t.false(wheel(text, -20));
  resetSwipeGestureForTests();
  cleanup();
  const again = render(<SwipePage onForward={() => (forward += 1)} />);
  const field = again.getByTestId("text");
  // Mostly vertical: scrolling, not navigation.
  for (let step = 0; step < 12; step += 1) wheel(field, 10, 40);
  t.is(forward, 0);
});

test.serial("a swipe over an element that scrolls sideways scrolls it", (t) => {
  let back = 0;
  const { getByTestId } = render(<SwipePage wide onBack={() => (back += 1)} />);
  const text = getByTestId("text");
  for (let step = 0; step < 12; step += 1) t.false(wheel(text, -20));
  t.is(back, 0);
});
