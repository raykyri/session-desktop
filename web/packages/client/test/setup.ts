import { register } from "node:module";

import globalJsdom from "global-jsdom";

// Vite resolves `*.svg` imports to a URL string; Node cannot load the file at
// all. Carried over from the desktop's `tests/svgStubLoader.mjs`.
register("./svgStubLoader.mjs", import.meta.url);

globalJsdom(undefined, { pretendToBeVisual: true, url: "http://localhost/" });

// Node 22 ships its own `Event`/`CustomEvent` globals, and they outrank
// jsdom's. A `CustomEvent` built from Node's constructor is not an instance of
// jsdom's `Event`, so `window.dispatchEvent` accepts it and then matches no
// listener — the shell's shortcut re-dispatch silently goes nowhere. Point the
// globals at the document's own constructors.
for (const name of [
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
] as const) {
  const constructor = (window as unknown as Record<string, unknown>)[name];
  if (constructor) (globalThis as Record<string, unknown>)[name] = constructor;
}

// React 19 refuses to run `act` without this, and Testing Library wraps every
// render in it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no layout, so selection code that measures a range fails
// without these stubs.
if (!Range.prototype.getClientRects) {
  const empty = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

// Floating UI (under every Base UI popup) observes its anchor; jsdom ships no
// ResizeObserver, and without one a portalled popup throws on open rather than
// rendering.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Pointer capture and `scrollIntoView` are unimplemented in jsdom; Base UI's
// menus and the command palette call both during ordinary keyboard use.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
