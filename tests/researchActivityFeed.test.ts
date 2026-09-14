import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, {
  recentActivityAnchorOffset,
  recentActivityAnchorScrollTop,
  type ResearchActivityFeedProps,
} from "../src/components/research/ResearchActivityFeed";
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

test("Home renders direct children as follow-up buttons within the root item", () => {
  const root = {
    nodeId: "root", treeId: "tree", parentNodeId: null, inline: false,
    prompt: "Root question", adapter: "codex", status: "complete" as const, createdAt: 100,
  };
  const html = renderFeed({ items: [{
    kind: "research-query", occurredAt: 100,
    query: { ...root, children: [{
      ...root, nodeId: "child", parentNodeId: "root", prompt: "Follow up question here",
      children: [{ ...root, nodeId: "grandchild", parentNodeId: "child", prompt: "Nested descendant" }],
    }] },
  }] });
  assert.match(html, /aria-label="Follow-up questions"/);
  assert.match(html, /recent-query-child-question">Follow up question here<\/span>/);
  assert.ok(html.indexOf("Root question") < html.indexOf("activity-metadata"));
  assert.ok(html.indexOf("activity-metadata") < html.indexOf("Follow up question here"));
  assert.equal((html.match(/aria-posinset=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Nested descendant/);
});

test("Home prefixes targeted follow-ups with a muted target excerpt", () => {
  const root = {
    nodeId: "root", treeId: "tree", parentNodeId: null, inline: false,
    prompt: "Root question", adapter: "codex", status: "complete" as const, createdAt: 100,
  };
  const target = "The selected answer passage has enough words to require a short excerpt here";
  const html = renderFeed({ items: [{
    kind: "research-query", occurredAt: 100,
    query: {
      ...root,
      children: [{
        ...root,
        nodeId: "child",
        parentNodeId: "root",
        prompt: "How does this change the result?",
        queryTarget: target,
      }],
    },
  }] });

  assert.match(
    html,
    /recent-query-child-target" title="[^"]+">@The selected answer passage has…<\/span>/,
  );
  assert.match(
    html,
    /recent-query-child-question">How does this change the result\?<\/span>/,
  );
  assert.ok(html.indexOf("recent-query-child-target") < html.indexOf("recent-query-child-question"));
  assert.match(html, /recent-query-child-target"[^>]*>[^<]+<\/span><button/);
});

test("Home places follow-up questions below the research summary", () => {
  const root = {
    nodeId: "root", treeId: "tree", parentNodeId: null, inline: false,
    prompt: "Root question", adapter: "codex", status: "complete" as const, createdAt: 100,
  };
  const html = renderFeed({ items: [{
    kind: "research-query", occurredAt: 100,
    query: {
      ...root,
      recap: "The root answer.",
      children: [{ ...root, nodeId: "child", parentNodeId: "root", prompt: "Follow up question" }],
    },
  }] });

  assert.ok(html.indexOf("Root question") < html.indexOf("activity-metadata"));
  assert.ok(html.indexOf("activity-metadata") < html.indexOf("Summary: The root answer."));
  assert.ok(html.indexOf("Summary: The root answer.") < html.indexOf("Follow up question"));
});

test("the agent setup guide appears only when the Home feed is empty", () => {
  const setupGuide = createElement("div", null, "Agent setup guide");

  const emptyWithGuide = renderFeed({ setupGuide });
  assert.match(emptyWithGuide, /Agent setup guide/);
  assert.doesNotMatch(emptyWithGuide, /appear here, newest first/);
  assert.match(renderFeed({}), /appear here, newest first/);
  assert.doesNotMatch(
    renderFeed({
      setupGuide,
      items: [
        {
          kind: "journal",
          occurredAt: 200,
          entry: {
            kind: "link",
            id: "link",
            createdAt: "1970-01-01T00:00:00.200Z",
            url: "https://example.com/finding",
          },
        },
      ],
    }),
    /Agent setup guide/,
  );
});

test("the feed scroll anchor round-trips correctly", () => {
  // Canvas top accounts for elements above the virtualized list.
  const canvasTop = 212;
  for (const [rowOffset, scrollTop] of [[0, 0], [1840, 1900], [4096, 300], [640, 640]]) {
    const offset = recentActivityAnchorOffset(canvasTop, rowOffset, scrollTop);
    assert.equal(
      recentActivityAnchorScrollTop(canvasTop, rowOffset, offset),
      scrollTop,
      `round trip for a row at ${rowOffset} viewed from ${scrollTop}`,
    );
  }
  // Negative offset across top edge round-trips correctly.
  assert.equal(recentActivityAnchorOffset(0, 500, 560), -60);
  assert.equal(recentActivityAnchorScrollTop(0, 500, -60), 560);
  // Scroll position clamps to zero if calculated offset is negative.
  assert.equal(recentActivityAnchorScrollTop(0, 40, 400), 0);
});
