import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useResearchSwipeNavigation } from "../src/hooks/useResearchSwipeNavigation";
import { withWidgetDom } from "./widgetDom";

interface SwipeHarness {
  calls: string[];
  target: HTMLElement;
  wheel: (x: number, y: number, options?: WheelEventInit, target?: HTMLElement) => WheelEvent;
  advance: (ms: number) => void;
  remount: () => Promise<void>;
}

async function withSwipe(run: (harness: SwipeHarness) => Promise<void> | void) {
  await withWidgetDom(async (window) => {
    const globals = {
      WheelEvent: window.WheelEvent,
      getComputedStyle: window.getComputedStyle.bind(window),
    };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    // Drive the real hook's window timers without wall-clock timing races.
    let now = 0;
    let nextTimer = 0;
    const timers = new Map<number, { due: number; callback: () => void }>();
    window.setTimeout = ((callback: () => void, delay = 0) => {
      timers.set(++nextTimer, { due: now + delay, callback });
      return nextTimer;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id?: number) => { timers.delete(id!); };
    const advance = (ms: number) => {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    };
    const calls: string[] = [];
    function Surface() {
      const ref = useRef<HTMLDivElement>(null);
      useResearchSwipeNavigation(ref, () => calls.push("back"), () => calls.push("forward"));
      return createElement("div", { ref, "data-swipe-surface": true });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let key = 0;
    const render = async () => {
      await act(async () => root.render(createElement(Surface, { key: ++key })));
    };
    try {
      await render();
      const harness: SwipeHarness = {
        calls,
        get target() { return container.querySelector<HTMLElement>("[data-swipe-surface]")!; },
        wheel(x, y, options = {}, target = harness.target) {
          const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: x, deltaY: y, ...options });
          target.dispatchEvent(event);
          return event;
        },
        advance,
        remount: render,
      };
      await run(harness);
    } finally {
      // Also expire the module-level momentum guard before restoring the DOM.
      advance(180);
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

test("vertical direction reversals cannot accumulate into history navigation", async () => {
  await withSwipe(({ wheel, calls }) => {
    for (const y of [100, -100, 100, -100]) {
      assert.equal(wheel(20, y).defaultPrevented, false);
    }
    assert.deepEqual(calls, []);
  });
});

test("vertical intent stays scrolling through subsequent horizontal drift", async () => {
  await withSwipe(({ wheel, calls, advance }) => {
    wheel(0, 20);
    for (let i = 0; i < 5; i++) {
      advance(100);
      assert.equal(wheel(100, 0).defaultPrevented, false);
    }
    assert.deepEqual(calls, []);
  });
});

test("pure vertical input never navigates or gets consumed", async () => {
  await withSwipe(({ wheel, calls }) => {
    for (const y of [1, -1, 16, -80, 800, -800]) {
      assert.equal(wheel(0, y).defaultPrevented, false);
    }
    assert.deepEqual(calls, []);
  });
});

test("deliberate horizontal swipes work in both directions despite tiny vertical startup jitter", async () => {
  await withSwipe(({ wheel, calls, advance }) => {
    for (const sign of [-1, 1]) {
      wheel(0, 2);
      assert.equal(wheel(sign * 40, 3).defaultPrevented, false);
      assert.equal(wheel(sign * 40, -3).defaultPrevented, true);
      advance(180);
    }
    assert.deepEqual(calls, ["back", "forward"]);
  });
});

test("absolute vertical travel also protects gestures without dominant vertical intent", async () => {
  await withSwipe(({ wheel, calls }) => {
    // Neither axis dominates, but signed Y would cancel to zero.
    for (const y of [24, -24, 24, -24]) wheel(20, y);
    assert.deepEqual(calls, []);
  });
});

test("scrolling intent resets only after 180ms without wheel input", async () => {
  await withSwipe(({ wheel, calls, advance }) => {
    wheel(0, 50);
    advance(179);
    wheel(100, 0);
    assert.deepEqual(calls, []);
    advance(180);
    assert.equal(wheel(80, 0).defaultPrevented, true);
    assert.deepEqual(calls, ["forward"]);
  });
});

test("overflowing horizontal containers retain gestures at both edges and after leaving the container", async () => {
  await withSwipe(({ wheel, calls, advance, target }) => {
    const scroller = document.createElement("div");
    const child = document.createElement("span");
    scroller.style.overflowX = "auto";
    Object.defineProperties(scroller, { clientWidth: { value: 200 }, scrollWidth: { value: 400 } });
    scroller.append(child);
    target.append(scroller);
    for (const edge of [0, 200]) {
      scroller.scrollLeft = edge;
      assert.equal(wheel(edge ? 100 : -100, 0, {}, child).defaultPrevented, false);
      assert.equal(wheel(100, 0).defaultPrevented, false);
      advance(180);
    }
    assert.deepEqual(calls, []);
    wheel(80, 0);
    assert.deepEqual(calls, ["forward"]);
  });
});

test("fitting horizontal containers allow history gestures", async () => {
  await withSwipe(({ wheel, calls, target }) => {
    target.style.overflowX = "auto";
    Object.defineProperties(target, { clientWidth: { value: 200 }, scrollWidth: { value: 200 } });
    wheel(-80, 0);
    assert.deepEqual(calls, ["back"]);
  });
});

test("modifiers and capture-phase handled wheel events do not contribute to gestures", async () => {
  await withSwipe(({ wheel, calls, target }) => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
      assert.equal(wheel(100, 100, { [modifier]: true }).defaultPrevented, false);
    }
    const consume = (event: Event) => event.preventDefault();
    target.addEventListener("wheel", consume, { capture: true, once: true });
    wheel(0, 100);
    wheel(80, 0);
    assert.deepEqual(calls, ["forward"]);
  });
});

test("line and page wheel units retain normalized thresholds and vertical intent", async () => {
  await withSwipe(({ wheel, calls, advance, target }) => {
    Object.defineProperty(target, "clientWidth", { value: 400 });
    wheel(4, 0, { deltaMode: 1 });
    assert.deepEqual(calls, []);
    wheel(1, 0, { deltaMode: 1 });
    assert.deepEqual(calls, ["forward"]);
    advance(180);
    wheel(-0.2, 0, { deltaMode: 2 });
    assert.deepEqual(calls, ["forward", "back"]);
    advance(180);
    wheel(0, 1, { deltaMode: 1 });
    wheel(100, 0);
    assert.equal(calls.length, 2);
  });
});

test("navigation momentum is suppressed across remounts without swallowing vertical scrolling", async () => {
  await withSwipe(async ({ wheel, calls, advance, remount }) => {
    wheel(80, 0);
    await remount();
    advance(100);
    assert.equal(wheel(100, 0).defaultPrevented, true);
    advance(100);
    assert.equal(wheel(0, 100).defaultPrevented, false);
    assert.deepEqual(calls, ["forward"]);
    advance(180);
    wheel(-80, 0);
    assert.deepEqual(calls, ["forward", "back"]);
  });
});
