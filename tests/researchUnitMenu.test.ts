import assert from "node:assert/strict";
import test from "node:test";
import { researchMenuPoint, researchMenuPosition } from "../src/components/research/ResearchMenu";
import {
  isResearchUnitMenuKey,
  researchUnitKeyboardPlacement,
  researchUnitMenuOpens,
} from "../src/components/research/researchUnitMenu";

const keys = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
const viewport = { width: 1000, height: 800 };
const size = { width: 220, height: 300 };
const opens = {
  handled: false,
  nativeTarget: false,
  selectionText: "",
  selectionInUnit: false,
};

test("Shift+F10 and the ContextMenu key open a unit's menu", () => {
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "ContextMenu" }), true);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "F10", shiftKey: true }), true);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "ContextMenu", shiftKey: true }), true);
});

test("F10 alone, modified presses and IME composition do not open a unit's menu", () => {
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "F10" }), false);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "F10", shiftKey: true, metaKey: true }), false);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "F10", shiftKey: true, ctrlKey: true }), false);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "ContextMenu", altKey: true }), false);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "ContextMenu", isComposing: true }), false);
  assert.equal(isResearchUnitMenuKey({ ...keys, key: "m", shiftKey: true }), false);
});

test("a right-click on a unit opens its menu", () => {
  assert.equal(researchUnitMenuOpens(opens), true);
});

test("handled right-clicks and native targets do not open the unit menu", () => {
  assert.equal(researchUnitMenuOpens({ ...opens, handled: true }), false);
  assert.equal(researchUnitMenuOpens({ ...opens, nativeTarget: true }), false);
});

test("a text selection in the unit does not open the unit menu", () => {
  assert.equal(
    researchUnitMenuOpens({ ...opens, selectionText: "a passage", selectionInUnit: true }),
    false,
  );
});

test("a selection elsewhere or containing only whitespace allows the unit menu", () => {
  assert.equal(researchUnitMenuOpens({ ...opens, selectionText: "a passage" }), true);
  assert.equal(researchUnitMenuOpens({ ...opens, selectionText: " \n ", selectionInUnit: true }), true);
});

test("keyboard invocation anchors the menu to the unit's … button", () => {
  const button = { rect: { left: 400, top: 100, right: 426, bottom: 126 }, align: "start" as const };
  assert.deepEqual(
    researchUnitKeyboardPlacement(button, { left: 0, top: 80, right: 500, bottom: 140 }, viewport),
    { anchor: button.rect, align: "start" },
  );
});

test("without a visible … button, keyboard invocation uses the visible unit corner", () => {
  assert.deepEqual(
    researchUnitKeyboardPlacement(null, { left: 320, top: 140, right: 900, bottom: 600 }, viewport),
    { anchor: researchMenuPoint(320, 140), align: "point" },
  );
  // A unit scrolled partly above the window opens at the window's top.
  assert.deepEqual(
    researchUnitKeyboardPlacement(null, { left: 320, top: -900, right: 900, bottom: 600 }, viewport),
    { anchor: researchMenuPoint(320, 0), align: "point" },
  );
});

test("a context menu at the pointer near an edge is clamped inside the window", () => {
  // Near the right edge: shifted left to keep the 8px margin.
  assert.deepEqual(researchMenuPosition(researchMenuPoint(990, 100), size, viewport, "point"), {
    left: 1000 - 8 - 220,
    top: 100,
  });
  // Near the bottom: opens above the pointer.
  assert.deepEqual(researchMenuPosition(researchMenuPoint(100, 790), size, viewport, "point"), {
    left: 100,
    top: 790 - 300,
  });
  // In the bottom-right corner: shifted left, and above the pointer within
  // the bottom margin.
  assert.deepEqual(researchMenuPosition(researchMenuPoint(995, 795), size, viewport, "point"), {
    left: 1000 - 8 - 220,
    top: 800 - 8 - 300,
  });
  // A keyboard open placed at the window's top-left corner stays inside the margin.
  assert.deepEqual(researchMenuPosition(researchMenuPoint(0, 0), size, viewport, "point"), {
    left: 8,
    top: 8,
  });
});
