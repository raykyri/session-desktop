import assert from "node:assert/strict";
import test from "node:test";
import { collectSearchRanges } from "../src/lib/transcriptSearch";

test("hidden text cannot exhaust the visible search cap", (t) => {
  const nodes = [{ nodeValue: "x".repeat(2_000), visible: false }, { nodeValue: "x".repeat(2_100), visible: true }];
  let index = 0;
  const descriptors = ["document", "NodeFilter"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: { SHOW_TEXT: 4 } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createTreeWalker: () => ({ nextNode: () => nodes[index++] ?? null }),
    createRange: () => {
      let node: typeof nodes[number];
      return {
        selectNodeContents: (next: typeof node) => { node = next; },
        setStart: (next: typeof node) => { node = next; },
        setEnd: () => {},
        getClientRects: () => node.visible ? [{}] : [],
      };
    },
  } });
  assert.equal(collectSearchRanges({} as HTMLElement, "x", { caseSensitive: false, regex: false }).length, 2_000);
});
