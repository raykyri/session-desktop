import assert from "node:assert/strict";
import test from "node:test";
import {
  clampResearchFeedWidth,
  maxResearchFeedWidth,
} from "../src/components/research/ResearchColumns";

test("resizing keeps the feed readable and reserves space for the answer", () => {
  assert.equal(clampResearchFeedWidth(100, 1200), 280);
  assert.equal(clampResearchFeedWidth(600, 1000), 520);
  assert.equal(maxResearchFeedWidth(1000), 520);
  assert.equal(clampResearchFeedWidth(900, 1800), 720);
  assert.equal(clampResearchFeedWidth(450, 1200), 450);
});

test("shrinking the window clamps display width without losing the user's preference", () => {
  const preferred = 650;
  assert.equal(clampResearchFeedWidth(preferred, 900), 420);
  assert.equal(clampResearchFeedWidth(preferred, 1300), preferred);
});

test("invalid saved widths recover to the default", () => {
  assert.equal(clampResearchFeedWidth(NaN, 1200), 384);
  assert.equal(clampResearchFeedWidth(Infinity, 1200), 384);
  assert.equal(clampResearchFeedWidth(-20, 1200), 280);
});

test("hidden or narrow columns keep valid bounds", () => {
  for (const available of [0, 200, 760, 880]) {
    const width = clampResearchFeedWidth(384, available);
    assert.ok(width >= 280);
    assert.ok(width <= maxResearchFeedWidth(available));
  }
});
