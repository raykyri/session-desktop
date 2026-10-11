import { JSDOM } from "jsdom";

/** Installs a real DOM for range and mounted-widget regression tests. Restores
 * every global afterwards so other tests keep their ordinary Node environment. */
export async function withWidgetDom(run: (window: JSDOM["window"]) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    await run(dom.window);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
