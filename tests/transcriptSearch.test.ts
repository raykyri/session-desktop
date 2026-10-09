import assert from "node:assert/strict";
import test from "node:test";
import { collectSearchRanges, mergeSearchMatches } from "../src/lib/transcriptSearch";

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

test("matches from several roots are searched in root order", () => {
  const { matches, index } = mergeSearchMatches(
    [["main-1", "main-2"], [], ["drawer-1"]],
    undefined,
    (a, b) => a === b,
    () => 0,
  );
  assert.deepEqual(matches, ["main-1", "main-2", "drawer-1"]);
  assert.equal(index, 0);
});

test("a rescan keeps the current match when it is still there, at its new index", () => {
  // Streaming text added a match before the current one.
  const rescanned = mergeSearchMatches([["new", "main-1"], ["drawer-1"]], "drawer-1", (a, b) => a === b, () => 0);
  assert.equal(rescanned.index, 2);
  // The current match is gone: the nearest one is picked instead.
  const gone = mergeSearchMatches([["main-1"], ["drawer-2"]], "drawer-1", (a, b) => a === b, (found) => found.length - 1);
  assert.equal(gone.index, 1);
  assert.equal(mergeSearchMatches<string>([[], []], undefined, (a, b) => a === b, () => -1).index, -1);
});
