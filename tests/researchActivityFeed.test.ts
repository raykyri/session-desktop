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
const savedLink = {
  nodeId: "link", treeId: "link-tree", parentNodeId: null, inline: false,
  prompt: "https://example.com/finding", adapter: "codex", kind: "note" as const,
  status: "complete" as const, createdAt: 200,
};

function renderFeed(overrides: Partial<ResearchActivityFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchActivityFeed, {
    composer: createElement("div", null, "Query composer"),
    items: [], researchTrees: [], nextCursor: null, loadingOlder: false, olderError: null,
    noteActions: {
      onAskFollowUp: asyncNoop, onRespond: asyncNoop,
      onDeleteResponse: asyncNoop, onRetry: asyncNoop,
    },
    onOpenResearchQuery: noop,
    onResearchRecapApplied: noop, onError: noop,
    folderState: emptyResearchFolderState(),
    onRenameResearch: asyncNoop, onArchiveResearch: asyncNoop,
    onRestoreResearch: asyncNoop, onRemoveResearch: asyncNoop,
    onToggleResearchStar: noop, onRequestCreateFolder: noop, onRemoveFromFolder: noop,
    onSetResearchFollowed: noop, onSetResearchBookmarked: noop,
    onLoadOlder: noop,
    onRefresh: noop, onBack: noop, onForward: noop,
    ...overrides,
  }));
}

test("Home renders the mixed feed and query composer directly in the app", () => {
  const html = renderFeed({
    items: [
      savedLink,
      { nodeId: "node", treeId: "tree", parentNodeId: null, inline: false, prompt: "Investigate this question", adapter: "codex", status: "complete", createdAt: 100, recap: "The finding is X." },
    ],
  });
  assert.match(html, /Home/);
  assert.match(html, /role="feed"/);
  assert.match(html, /journal-column research-reading-surface/);
  assert.match(html, /note-link-card research-content-card/);
  assert.match(
    html,
    /research-user-message recent-query-card research-prompt/,
  );
  assert.match(html, /research-summary-text research-recap recent-query-recap/);
  assert.match(html, /Query composer/);
  assert.match(html, /example.com\/finding/);
  assert.match(html, /Investigate this question/);
  assert.match(html, />Saved link · example\.com · <button[^>]*activity-metadata-open[^>]*><time/);
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

test("research cards end with Follow and Bookmark beside the time", () => {
  const query = { nodeId: "node", treeId: "tree", parentNodeId: null, inline: false, prompt: "Investigate this question", adapter: "codex", status: "complete" as const, createdAt: 100, recap: "The finding is X." };
  const tree = {
    id: "tree", title: "Investigate", rootNodeId: "node", kind: "run" as const, workspaceId: "ws",
    runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 100,
    archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false,
  };
  const html = renderFeed({
    items: [query],
    researchTrees: [{ ...tree, followed: true, bookmarked: true }],
  });
  const footer = html.indexOf('class="recent-query-footer"');
  assert.ok(footer > 0);
  // The footer is the card's last block: after the recap, with actions before the metadata.
  assert.ok(html.indexOf("Summary: The finding is X.") < footer);
  assert.ok(footer < html.indexOf("research-thread-actions"));
  assert.ok(html.indexOf("research-thread-actions") < html.indexOf('class="recent-query-metadata"'));
  assert.match(html, /research-thread-follow is-active"[^>]*aria-pressed="true"[^>]*>Following<\/button>/);
  assert.match(html, /research-thread-bookmark is-active"[^>]*aria-pressed="true"[^>]*aria-label="Remove bookmark"/);
  assert.match(html, /recent-query-metadata"><div class="activity-metadata"[^>]*><span class="activity-metadata-summary"><time/);

  const unflagged = renderFeed({
    items: [query],
    researchTrees: [tree],
  });
  assert.match(unflagged, /research-thread-follow"[^>]*aria-pressed="false"[^>]*>Follow<\/button>/);
  assert.match(unflagged, /aria-label="Bookmark"/);
  // Saved links are threads too: the same pair follows the link card.
  const saved = renderFeed({
    items: [savedLink],
    researchTrees: [{ ...tree, id: "link-tree", rootNodeId: "link", kind: "note" }],
  });
  assert.match(saved, /research-thread-actions/);
  assert.ok(saved.indexOf("note-link-card") < saved.indexOf("research-thread-actions"));
});

test("the Bookmarks view lists only bookmarked threads without the composer", () => {
  const query = { nodeId: "node", treeId: "tree", parentNodeId: null, inline: false, prompt: "Bookmarked question", adapter: "codex", status: "complete" as const, createdAt: 100 };
  const other = { ...query, nodeId: "other-node", treeId: "other", prompt: "Unbookmarked question" };
  const tree = {
    id: "tree", title: "Investigate", rootNodeId: "node", kind: "run" as const, workspaceId: "ws",
    runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 100,
    archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false, bookmarked: true,
  };
  const items = [
    { ...savedLink, prompt: "https://example.com/saved", createdAt: 300 },
    other,
    query,
  ];
  const html = renderFeed({
    view: "bookmarks",
    items,
    researchTrees: [tree, { ...tree, id: "other", rootNodeId: "other-node", bookmarked: false }],
    setupGuide: createElement("div", null, "Setup guide"),
  });
  assert.match(html, /Bookmarks/);
  assert.match(html, /aria-label="Refresh Bookmarks"/);
  assert.match(html, /Bookmarked question/);
  assert.doesNotMatch(html, /Unbookmarked question/);
  assert.doesNotMatch(html, /example.com\/saved/);
  assert.doesNotMatch(html, /Query composer/);
  assert.doesNotMatch(html, /Setup guide/);

  const empty = renderFeed({ view: "bookmarks", items, researchTrees: [{ ...tree, bookmarked: false }] });
  assert.match(empty, /Bookmarked research appears here/);
  assert.doesNotMatch(empty, /Bookmarked question/);

  const home = renderFeed({ items, researchTrees: [tree] });
  assert.match(home, /Unbookmarked question/);
  assert.match(home, /Query composer/);
});

test("feed pagination errors remain visible with workspace history controls", () => {
  const html = renderFeed({
    nextCursor: { createdAt: 100, nodeId: "link" },
    olderError: "Temporarily unavailable",
    canGoBack: true,
  });
  assert.match(html, /Retry older activity/);
  assert.match(html, /Temporarily unavailable/);
  assert.doesNotMatch(html, /Entry removed/);
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /aria-label="Forward"/);
});

test("Home renders direct children as follow-up buttons within the root item", () => {
  const root = {
    nodeId: "root", treeId: "tree", parentNodeId: null, inline: false,
    prompt: "Root question", adapter: "codex", status: "complete" as const, createdAt: 100,
  };
  const html = renderFeed({ items: [{ ...root, children: [{
      ...root, nodeId: "child", parentNodeId: "root", prompt: "Follow up question here",
      children: [{ ...root, nodeId: "grandchild", parentNodeId: "child", prompt: "Nested descendant" }],
    }] },
  ] });
  assert.match(html, /aria-label="Follow-up questions"/);
  assert.match(html, /recent-query-child-question">Follow up question here<\/span>/);
  assert.ok(html.indexOf("Root question") < html.indexOf("Follow up question here"));
  // The footer (actions + time) closes the item, after the follow-up list.
  assert.ok(html.indexOf("Follow up question here") < html.indexOf("activity-metadata"));
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
      ...root,
      children: [{
        ...root,
        nodeId: "child",
        parentNodeId: "root",
        prompt: "How does this change the result?",
        queryTarget: target,
      }],
    },
  ] });

  assert.match(
    html,
    /recent-query-child-target" title="[^"]+">@The selected answer passage has…<\/span>/,
  );
  assert.match(
    html,
    /recent-query-child-question">How does this change the result\?<\/span>/,
  );
  assert.ok(html.indexOf("recent-query-child-target") < html.indexOf("recent-query-child-question"));
  assert.match(
    html,
    /recent-query-child-target"[^>]*>[^<]+<\/span> <span class="recent-query-child-link" role="button"/,
  );
});

test("Home places follow-up questions below the research summary", () => {
  const root = {
    nodeId: "root", treeId: "tree", parentNodeId: null, inline: false,
    prompt: "Root question", adapter: "codex", status: "complete" as const, createdAt: 100,
  };
  const html = renderFeed({ items: [{
      ...root,
      recap: "The root answer.",
      children: [{ ...root, nodeId: "child", parentNodeId: "root", prompt: "Follow up question" }],
    },
  ] });

  assert.ok(html.indexOf("Root question") < html.indexOf("Summary: The root answer."));
  assert.ok(html.indexOf("Summary: The root answer.") < html.indexOf("Follow up question"));
  assert.ok(html.indexOf("Follow up question") < html.indexOf("activity-metadata"));
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
      items: [savedLink],
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


test("Home offers report import and imported cards identify provenance", () => {
  const html = renderFeed({ onImportReport: asyncNoop, items: [{
    nodeId: "import", treeId: "import-tree", inline: false, prompt: "Original prompt",
    adapter: "codex", model: null, origin: "imported", status: "complete", createdAt: 100,
  }] });
  assert.match(html, /Import report/);
  assert.match(html, /accept=".md,text\/markdown"/);
  assert.match(html, /Imported <time/);
  assert.doesNotMatch(renderFeed({ view: "bookmarks", onImportReport: asyncNoop }), /Import report/);
});

const member = (id: string, displayName: string) =>
  ({ kind: "member" as const, id, displayName, handle: id });

function networkNote(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "note", treeId: "note-tree", parentNodeId: null, inline: false,
    prompt: "Who ships component-model plugins?", adapter: "claude", model: "fable",
    kind: "note" as const, status: "complete" as const, createdAt: 100,
    delivery: { status: "posted" as const, postedAt: 100 },
    ...overrides,
  };
}

test("a network note with no replies shows the placeholder and a collapsed follow-up link", () => {
  const html = renderFeed({ items: [networkNote()] });
  assert.match(html, /Who ships component-model plugins\?/);
  assert.match(html, />Posted to network · <button[^>]*activity-metadata-open[^>]*><time/);
  assert.match(html, /No replies yet\. Replies from your network will appear here\./);
  assert.match(html, /\+ Ask a follow-up/);
  assert.doesNotMatch(html, /aria-label="Follow-up"/);
  assert.doesNotMatch(html, />Follow-ups</);
});

test("a network note lists replies with responses, then follow-ups with their state", () => {
  const html = renderFeed({ items: [networkNote({
    replyCount: 7,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [
        { id: "r1", author: member("ana", "Ana Moreau"), body: "We moved in March.", createdAt: 110 },
        { id: "r2", author: { kind: "author" }, body: "Owned handles?", inReplyTo: "r1", createdAt: 120 },
      ],
    },
    children: [
      { ...networkNote(), nodeId: "ai", parentNodeId: "note", kind: "run", delivery: null,
        prompt: "Does wasmtime support async?", status: "complete", recap: "Yes, since 25.", createdAt: 130 },
      { ...networkNote(), nodeId: "about", parentNodeId: "note", kind: "run", delivery: null,
        prompt: "How big is the SDK?", replyAnchor: "r1", replyAnchorAuthor: "Ana Moreau",
        status: "running", createdAt: 140 },
      { ...networkNote(), nodeId: "failed", parentNodeId: "note", kind: "run", delivery: null,
        prompt: "Which projects ship them?", status: "failed", error: "agent exited", createdAt: 150 },
      { ...networkNote(), nodeId: "net", parentNodeId: "note", prompt: "Anyone measured wizer?",
        replyCount: 1, createdAt: 160,
        delivery: { status: "posted", postedAt: 160, replies: [
          { id: "j1", author: member("jun", "Jun Sato"), body: "About 0.4 ms.", createdAt: 170 },
        ] } },
    ],
  })] });
  assert.match(html, />Posted to network · 7 replies · <button/);
  // Replies come before follow-ups; a response nests under its reply.
  assert.ok(html.indexOf("We moved in March.") < html.indexOf("Owned handles?"));
  assert.ok(html.indexOf("Owned handles?") < html.indexOf(">Follow-ups<"));
  assert.match(html, /note-thread-list is-nested/);
  assert.match(html, />AM<\/span>/);
  assert.match(html, />Respond<\/button>/);
  assert.match(html, />Ask AI about this<\/button>/);
  assert.match(html, />Delete<\/button>/);
  // The payload carries one of seven threads, so six are hidden.
  assert.match(html, /Show 6 more replies/);
  // Follow-up rows, in order, with each state.
  assert.ok(html.indexOf("Does wasmtime support async?") < html.indexOf("How big is the SDK?"));
  assert.match(html, /Summary: Yes, since 25\./);
  assert.match(html, /note-followup-target">@Ana Moreau’s reply <\/span>How big is the SDK\?/);
  assert.match(html, />Answering</);
  assert.match(html, /Failed: agent exited/);
  assert.match(html, />Retry<\/button>/);
  assert.match(html, /Posted to network<span aria-hidden="true">·<\/span>1 reply/);
  assert.match(html, /About 0\.4 ms\./);
  // The field is open once a note has follow-ups, with the AI / Network toggle.
  assert.match(html, /aria-label="Follow-up"/);
  assert.match(html, /note-field-mode-button is-active"[^>]*>AI</);
  assert.match(html, />Network</);
});

test("saved links and posts take AI follow-ups only", () => {
  const html = renderFeed({ items: [{ ...savedLink, children: [
    { ...savedLink, nodeId: "child", parentNodeId: "link", kind: "run", prompt: "Summarize the page",
      status: "complete", createdAt: 210 },
  ] }] });
  assert.doesNotMatch(html, /No replies yet/);
  assert.doesNotMatch(html, />Network</);
  assert.match(html, /placeholder="Ask about this page"/);
  assert.match(html, /Summarize the page/);
});
