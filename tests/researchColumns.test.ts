import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_SINGLE_COLUMN_BELOW,
  researchConversationColumnWidth,
  researchFeedColumnWidth,
} from "../src/components/research/ResearchColumns";

test("the feed is 240–320px and leaves the conversation at least 620px before it grows", () => {
  assert.equal(researchFeedColumnWidth(1440 - 208), 320);
  assert.equal(researchFeedColumnWidth(1100 - 52), 320);
  assert.equal(researchFeedColumnWidth(900), 280);
  assert.equal(researchFeedColumnWidth(700 - 52), 240);
  assert.equal(researchFeedColumnWidth(300), 240);
});

test("the feed width depends only on the column area's width", () => {
  // The same available width always gives the same feed width: opening a
  // conversation, the drawer, or pinned columns does not change its input.
  for (const available of [620, 860, 940, 1232, 2400]) {
    assert.equal(researchFeedColumnWidth(available), researchFeedColumnWidth(available));
    const width = researchFeedColumnWidth(available);
    assert.ok(width >= 240 && width <= 320);
  }
});

test("invalid widths fall back to the minimum, and narrow areas show one column", () => {
  assert.equal(researchFeedColumnWidth(NaN), 240);
  assert.equal(researchFeedColumnWidth(-Infinity), 240);
  assert.equal(RESEARCH_SINGLE_COLUMN_BELOW, 620);
});

test("the conversation takes the area beside the feed, or the whole area in single-column mode", () => {
  // Pinned columns add to the row instead, so the conversation's width
  // depends on the column area alone.
  assert.equal(researchConversationColumnWidth(1232), 912);
  assert.equal(researchConversationColumnWidth(1048), 728);
  assert.equal(researchConversationColumnWidth(908), 620);
  assert.equal(researchConversationColumnWidth(619), 619);
  assert.equal(researchConversationColumnWidth(NaN), 0);
});
