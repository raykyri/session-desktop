import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, { type ResearchActivityFeedProps } from "../src/components/research/ResearchActivityFeed";

const noop = () => {};
function renderFeed(overrides: Partial<ResearchActivityFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchActivityFeed, {
    items: [], researchTrees: [], nextCursor: null, loadingOlder: false, olderError: null,
    pendingUndo: null, onAddEntry: noop, onRemoveEntry: noop, onRetryTweet: noop,
    onUndoRemove: noop, onDismissUndo: noop, onOpenResearchQuery: noop, onLoadOlder: noop,
    onRefresh: noop, onBack: noop, onForward: noop,
    ...overrides,
  }));
}

test("Research Activity renders the mixed feed and composer directly in the app", () => {
  const html = renderFeed({
    initialDraft: "Unfinished note",
    items: [
      { kind: "journal", occurredAt: 200, entry: { kind: "note", id: "note", createdAt: "1970-01-01T00:00:00.200Z", text: "Saved finding" } },
      { kind: "research-query", occurredAt: 100, query: { nodeId: "node", treeId: "tree", parentNodeId: null, inline: false, prompt: "Investigate this question", adapter: "codex", status: "running", createdAt: 100 } },
    ],
  });
  assert.match(html, /Research Activity/);
  assert.match(html, /role="feed"/);
  assert.match(html, /Unfinished note/);
  assert.match(html, /Saved finding/);
  assert.match(html, /Investigate this question/);
  assert.match(html, /aria-label="Refresh activity"/);
  assert.doesNotMatch(html, /<iframe|View source|Connecting to/);
});

test("feed pagination errors and deletion undo remain visible with workspace history controls", () => {
  const html = renderFeed({
    nextCursor: { occurredAt: 100, sourceRank: 0, id: "note" },
    olderError: "Temporarily unavailable",
    pendingUndo: { entry: { kind: "note", id: "deleted", createdAt: "1970-01-01T00:00:00.100Z", text: "Restore me" } },
    canGoBack: true,
  });
  assert.match(html, /Retry older activity/);
  assert.match(html, /Temporarily unavailable/);
  assert.match(html, /Note<!-- --> removed|Note removed/);
  assert.match(html, /Dismiss undo/);
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /aria-label="Forward"/);
});
