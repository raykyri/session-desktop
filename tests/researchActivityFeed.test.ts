import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, { type ResearchActivityFeedProps } from "../src/components/research/ResearchActivityFeed";
import { emptyResearchFolderState } from "../src/lib/researchFolders";

const noop = () => {};
const asyncNoop = async () => {};
function renderFeed(overrides: Partial<ResearchActivityFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchActivityFeed, {
    composer: createElement("div", null, "Query composer"),
    items: [], researchTrees: [], nextCursor: null, loadingOlder: false, olderError: null,
    pendingUndo: null, onRemoveEntry: noop, onRetryTweet: noop,
    onUndoRemove: noop, onDismissUndo: noop, onOpenResearchQuery: noop,
    onResearchRecapApplied: noop, onError: noop,
    folderState: emptyResearchFolderState(),
    onRenameResearch: asyncNoop, onArchiveResearch: asyncNoop,
    onRestoreResearch: asyncNoop, onRemoveResearch: asyncNoop,
    onToggleResearchStar: noop, onRequestCreateFolder: noop, onRemoveFromFolder: noop,
    onLoadOlder: noop,
    onRefresh: noop, onBack: noop, onForward: noop,
    ...overrides,
  }));
}

test("Home renders the mixed feed and query composer directly in the app", () => {
  const html = renderFeed({
    items: [
      { kind: "journal", occurredAt: 200, entry: { kind: "link", id: "link", createdAt: "1970-01-01T00:00:00.200Z", url: "https://example.com/finding" } },
      { kind: "research-query", occurredAt: 100, query: { nodeId: "node", treeId: "tree", parentNodeId: null, inline: false, prompt: "Investigate this question", adapter: "codex", status: "complete", createdAt: 100, recap: "The finding is X." } },
    ],
  });
  assert.match(html, /Home/);
  assert.match(html, /role="feed"/);
  assert.match(html, /journal-column research-reading-surface/);
  assert.match(html, /journal-entry research-content-card/);
  assert.match(
    html,
    /research-user-message recent-query-card research-prompt/,
  );
  assert.match(html, /research-summary-text research-recap recent-query-recap/);
  assert.match(html, /Query composer/);
  assert.match(html, /example.com\/finding/);
  assert.match(html, /Investigate this question/);
  assert.match(html, />Saved <time/);
  assert.match(html, /activity-metadata-summary"><time/);
  assert.doesNotMatch(html, />Asked <time/);
  assert.match(html, /Summary: The finding is X\./);
  assert.match(html, /aria-label="Refresh Home"/);
  assert.match(
    html,
    /class="control-button research-history-button"[^>]*aria-label="Refresh Home"/,
  );
  assert.doesNotMatch(html, />Refresh<\/button>/);
  assert.doesNotMatch(html, /You asked/);
  assert.doesNotMatch(html, /<iframe|View source|Connecting to/);
});

test("feed pagination errors and deletion undo remain visible with workspace history controls", () => {
  const html = renderFeed({
    nextCursor: { occurredAt: 100, sourceRank: 0, id: "link" },
    olderError: "Temporarily unavailable",
    pendingUndo: { entry: { kind: "link", id: "deleted", createdAt: "1970-01-01T00:00:00.100Z", url: "https://example.com/restore" } },
    canGoBack: true,
  });
  assert.match(html, /Retry older activity/);
  assert.match(html, /Temporarily unavailable/);
  assert.match(html, /Entry removed/);
  assert.match(html, /Dismiss undo/);
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /aria-label="Forward"/);
});
