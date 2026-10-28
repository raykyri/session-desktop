import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import ResearchColumns from "../src/components/research/ResearchColumns";
import { withWidgetDom } from "./widgetDom";

/** A mounted strip with controllable geometry, media queries and frame clock.
 * Tests exercise the real observers and effects without relying on jsdom to
 * lay out columns or provide a GPU-backed canvas. */
async function withAmbient(run: (harness: {
  window: Parameters<Parameters<typeof withWidgetDom>[0]>[0];
  host: HTMLDivElement;
  render: (reduceMotion?: boolean, extraColumn?: boolean) => Promise<void>;
  resize: () => Promise<void>;
  media: Map<string, MediaQueryList>;
  timers: Map<number, () => void>;
  paintCount: () => number;
  frameSignature: () => number;
  canvasWidth: (width: number) => void;
  observerCount: () => number;
}) => Promise<void>) {
  await withWidgetDom(async (window) => {
    const observers = new Set<{ callback: () => void }>();
    class ResizeObserverStub {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; observers.add(this); }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    }
    const globals = {
      ResizeObserver: ResizeObserverStub,
      MutationObserver: window.MutationObserver,
      getComputedStyle: window.getComputedStyle.bind(window),
    };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const media = new Map<string, MediaQueryList>();
    window.matchMedia = (query) => {
      if (!media.has(query)) {
        const target = new window.EventTarget() as unknown as MediaQueryList;
        Object.defineProperty(target, "matches", { value: false, writable: true });
        media.set(query, target);
      }
      return media.get(query)!;
    };
    const timers = new Map<number, () => void>();
    let timerId = 0;
    window.setTimeout = ((callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id) => { if (id !== undefined) timers.delete(id); };
    let paints = 0;
    let signature = 0;
    let canvasWidth = 440;
    const context = {
      globalAlpha: 1,
      clearRect() { paints++; signature = 0; },
      setTransform() {},
      fillText(text: string, x: number, y: number) {
        signature += text.charCodeAt(0) * this.globalAlpha * (x + y + 1);
      },
    };
    window.HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
    window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, bottom: 800, right: canvasWidth, width: canvasWidth, height: 800, toJSON() {},
    });
    Object.defineProperties(window.HTMLElement.prototype, {
      clientWidth: { configurable: true, get() { return 1200; } },
      offsetLeft: { configurable: true, get() { return Number(this.dataset.left ?? 0); } },
      offsetWidth: { configurable: true, get() { return Number(this.dataset.width ?? (this.dataset.researchColumn === "feed" ? 240 : 0)); } },
    });
    window.HTMLElement.prototype.getClientRects = (() => [{ width: 1200, height: 800 }]) as unknown as typeof window.HTMLElement.prototype.getClientRects;
    const { createRoot } = await import("react-dom/client");
    const host = window.document.createElement("div");
    host.className = "app-shell";
    window.document.body.append(host);
    const root = createRoot(host);
    const render = async (reduceMotion = false, extraColumn = false) => {
      await act(async () => root.render(createElement(ResearchColumns, {
        hasThread: true,
        reduceMotion,
        feed: createElement("button", null, "Home"),
        children: createElement("div", { className: "research-pairs" },
          createElement("section", { "data-research-column": "A0", "data-left": "240", "data-width": "520" }, "Answer"),
          extraColumn ? createElement("section", { "data-research-column": "A1", "data-left": "760", "data-width": "440" }, "Branch") : null,
        ),
      })));
    };
    const resize = async () => { await act(async () => {
      for (const observer of [...observers]) observer.callback();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }); };
    try {
      await render();
      await run({ window, host, render, resize, media, timers, paintCount: () => paints,
        frameSignature: () => signature,
        canvasWidth: (width) => { canvasWidth = width; }, observerCount: () => observers.size });
    } finally {
      await act(async () => root.unmount());
      assert.equal(timers.size, 0, "unmount cancels animation");
      assert.equal(observers.size, 0, "unmount disconnects resize observers");
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

test("ambient region follows the last column, scrolling, branch changes and resize slack", async () => {
  await withAmbient(async ({ host, window, render, resize }) => {
    const region = host.querySelector<HTMLElement>(".research-ambient")!;
    const row = host.querySelector<HTMLElement>(".research-columns-row")!;
    assert.equal(region.style.getPropertyValue("--ambient-start"), "760px");
    assert.ok(host.querySelector('[aria-label="Expand background"]'));
    // Resize slack is decorative empty space and must not count as a column.
    host.querySelector<HTMLElement>(".research-strip-slack")!.style.width = "200px";
    row.scrollLeft = 100;
    await act(async () => {
      row.dispatchEvent(new window.Event("scroll"));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    assert.equal(region.style.getPropertyValue("--ambient-start"), "660px");
    row.scrollLeft = 0;
    await render(false, true);
    await resize();
    assert.equal(region.style.getPropertyValue("--ambient-start"), "1200px");
    assert.equal(host.querySelector('[aria-label="Expand background"]'), null);
    await render();
    await resize();
    assert.equal(region.style.getPropertyValue("--ambient-start"), "760px");
  });
});

test("animation keeps producing changing frames and resumes its phase after Reduce motion", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  await withAmbient(async ({ render, timers, paintCount, frameSignature }) => {
    const initial = frameSignature();
    const before = paintCount();
    for (let frame = 0; frame < 120; frame++) {
      assert.equal(timers.size, 1, "each frame schedules its successor");
      const [id, tick] = timers.entries().next().value!;
      timers.delete(id);
      now += 1000 / 12;
      tick();
    }
    assert.equal(paintCount(), before + 120);
    const advanced = frameSignature();
    assert.notEqual(advanced, initial, "the drifting cloud changes character opacity over time");
    await render(true);
    assert.equal(timers.size, 0);
    assert.equal(frameSignature(), advanced, "Reduce motion freezes the current frame");
    now += 60_000;
    await render(false);
    assert.equal(frameSignature(), advanced, "resuming does not restart or jump ahead");
    assert.equal(timers.size, 1);
  });
});

test("expansion slides the columns away; Escape restores them and retains scroll and focus", async () => {
  await withAmbient(async ({ host, window }) => {
    const row = host.querySelector<HTMLElement>(".research-columns-row")!;
    const button = host.querySelector<HTMLButtonElement>(".research-ambient-toggle")!;
    row.scrollLeft = 37;
    await act(async () => button.click());
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const hiddenCycle = new window.KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true });
    await act(async () => window.dispatchEvent(hiddenCycle));
    assert.equal(hiddenCycle.defaultPrevented, true, "hidden columns still take cycle shortcuts");
    const dialog = window.document.createElement("div");
    dialog.setAttribute("role", "dialog");
    host.append(dialog);
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    assert.equal(button.getAttribute("aria-expanded"), "true", "Escape leaves the background open while a dialog is shown");
    dialog.remove();
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(row.scrollLeft, 37);
    assert.equal(window.document.activeElement, button);
    const shownCycle = new window.KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true });
    await act(async () => window.dispatchEvent(shownCycle));
    assert.equal(shownCycle.defaultPrevented, true, "restored columns resume cycle shortcuts");
  });
});

test("animation pauses for app/system reduced motion, hidden windows and covered regions", async () => {
  await withAmbient(async ({ host, window, render, resize, timers, media, paintCount, canvasWidth }) => {
    assert.equal(timers.size, 1);
    await render(true);
    assert.equal(timers.size, 0, "app Reduce motion renders a still frame");
    await render(false);
    const motion = media.get("(prefers-reduced-motion: reduce)")!;
    Object.assign(motion, { matches: true });
    const before = paintCount();
    motion.dispatchEvent(new window.Event("change"));
    assert.ok(paintCount() > before);
    assert.equal(timers.size, 0);
    Object.assign(motion, { matches: false });
    motion.dispatchEvent(new window.Event("change"));
    assert.equal(timers.size, 1);
    Object.defineProperty(window.document, "hidden", { value: true, configurable: true });
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(timers.size, 0);
    Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(timers.size, 1);
    canvasWidth(0);
    await resize();
    assert.equal(timers.size, 0);
    assert.equal(host.querySelector("canvas")!.width, 0, "covered background releases its backing store");
    canvasWidth(440);
    await resize();
    assert.equal(timers.size, 1);
    canvasWidth(20000);
    await resize();
    const canvas = host.querySelector("canvas")!;
    assert.ok(canvas.width * canvas.height < 2_510_000, "large displays keep a bounded backing store");
    assert.equal(timers.size, 1, "resizing never duplicates the animation loop");
    const contrast = media.get("(forced-colors: active)")!;
    Object.assign(contrast, { matches: true });
    contrast.dispatchEvent(new window.Event("change"));
    assert.equal(timers.size, 0);
  });
});
