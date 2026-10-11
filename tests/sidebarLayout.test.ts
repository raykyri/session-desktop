import assert from "node:assert/strict";
import test from "node:test";
import { clampSidebarWidth, maxSidebarWidth, SIDEBAR_MIN_WIDTH } from "../src/lib/sidebarLayout";

test("sidebar width preserves the minimum stage width up to the maximum sidebar width", () => {
  assert.equal(maxSidebarWidth(1600), 420);
  assert.equal(maxSidebarWidth(700.6), 320);
  assert.equal(maxSidebarWidth(500), SIDEBAR_MIN_WIDTH);
});

test("widths are clamped to the bounds and rounded to whole pixels", () => {
  assert.equal(clampSidebarWidth(100, 1600), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(900, 1600), 420);
  assert.equal(clampSidebarWidth(300.4, 1600), 300);
  assert.equal(clampSidebarWidth(300.5, 700), 301);
  assert.equal(clampSidebarWidth(400, 700), 320);
});
