import { register } from "node:module";

import globalJsdom from "global-jsdom";

// Icons are imported as URLs by Vite; Node cannot load them at all.
register("./svgStubLoader.mjs", import.meta.url);

globalJsdom(undefined, { pretendToBeVisual: true, url: "http://localhost/" });

// jsdom implements no layout, so selection code that measures a range fails
// without these stubs.
if (!Range.prototype.getClientRects) {
  const empty = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
