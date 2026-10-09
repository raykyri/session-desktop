import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  researchColumnsShown,
  researchConversationColumnWidth,
  researchFeedColumnWidth,
} from "../src/components/research/ResearchColumns";
import { ResearchConversationHeader } from "../src/components/research/ResearchDocumentChrome";
import { RESEARCH_SINGLE_COLUMN_BELOW } from "../src/lib/researchBranchView";

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

test("single-column mode shows the feed until a thread opens, the thread until Back to feed", () => {
  const wide = researchColumnsShown({ single: false, hasDocument: true, feedFocused: true });
  assert.deepEqual(wide, { showsFeed: true, feedHidden: false, contentHidden: false });
  assert.deepEqual(researchColumnsShown({ single: true, hasDocument: false, feedFocused: false }), {
    showsFeed: true,
    feedHidden: false,
    contentHidden: true,
  });
  // A thread opens: it shows and the feed is hidden (still mounted).
  assert.deepEqual(researchColumnsShown({ single: true, hasDocument: true, feedFocused: false }), {
    showsFeed: false,
    feedHidden: true,
    contentHidden: false,
  });
  // Back to feed focuses the feed: the thread is hidden, not closed.
  assert.deepEqual(researchColumnsShown({ single: true, hasDocument: true, feedFocused: true }), {
    showsFeed: true,
    feedHidden: false,
    contentHidden: true,
  });
});

const noop = () => {};
const header = (props: Partial<Parameters<typeof ResearchConversationHeader>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ResearchConversationHeader, {
      title: "A thread",
      canGoBack: true,
      canGoForward: false,
      backTitle: "Back (⌘[)",
      forwardTitle: "Forward (⌘])",
      onBack: noop,
      onForward: noop,
      imported: false,
      archived: false,
      followed: false,
      bookmarked: false,
      onToggleFollow: noop,
      onToggleBookmark: noop,
      ...props,
    }),
  );

test("the single-column Back to feed button is named apart from history Back", () => {
  const html = header({ onColumnBack: noop });
  assert.equal(html.match(/aria-label="Back to feed"/g)?.length, 1);
  assert.equal(html.match(/aria-label="Back"/g)?.length, 1);
  assert.match(html, /<div class="research-history-nav" role="group" aria-label="Research history">/);
  assert.doesNotMatch(header(), /Back to feed/);
});

test("a narrow uncovered column drops the history arrows for the title", () => {
  assert.doesNotMatch(header({ showHistory: false }), /research-history-nav/);
  assert.match(header(), /research-history-nav/);
});
