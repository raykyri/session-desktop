import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, {
  feedPostCounts,
  recentActivityAnchorOffset,
  recentActivityAnchorScrollTop,
  type ResearchActivityFeedProps,
} from "../src/components/research/ResearchActivityFeed";

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
    onOpenResearchQuery: noop,
    onResearchRecapApplied: noop, onError: noop,
    onRenameResearch: asyncNoop, onArchiveResearch: asyncNoop,
    onRestoreResearch: asyncNoop, onRemoveResearch: asyncNoop,
    onSetResearchFollowed: noop, onSetResearchBookmarked: noop,
    onLoadOlder: noop,
    onRefresh: noop, onBack: noop, onForward: noop,
    ...overrides,
  }));
}

const tree = {
  id: "tree", title: "Investigate", rootNodeId: "node", kind: "run" as const, workspaceId: "ws",
  runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 100,
  archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false,
};
const question = {
  nodeId: "node", treeId: "tree", parentNodeId: null, inline: false,
  prompt: "Investigate this question", adapter: "codex", status: "complete" as const,
  createdAt: 100, recap: "The finding is X.",
};

test("Home renders the mixed feed as posts beside the query composer", () => {
  const html = renderFeed({ items: [savedLink, question], researchTrees: [tree] });
  assert.match(html, /Home/);
  assert.match(html, /role="feed"/);
  assert.match(html, /journal-column research-reading-surface/);
  assert.equal((html.match(/class="research-feed-post"/g) ?? []).length, 2);
  assert.match(html, /note-link-card research-content-card/);
  assert.match(html, /research-user-message research-feed-post-message/);
  assert.match(html, /research-summary-text research-feed-post-summary is-clamped/);
  assert.match(html, /Query composer/);
  assert.match(html, /example.com\/finding/);
  assert.doesNotMatch(html, /research-feed-post-head|You asked Codex/);
  // The generated title leads, then the question, then the summary.
  assert.ok(html.indexOf("research-feed-post-title\">Investigate<") < html.indexOf("Investigate this question"));
  assert.ok(html.indexOf("Investigate this question") < html.indexOf("Summary: The finding is X."));
  assert.match(html, /aria-label="Refresh Home"/);
  assert.doesNotMatch(html, /<iframe|View source|Connecting to/);
});

test("a post's footer reads time and counts, then Follow and Bookmark at its trailing edge", () => {
  const html = renderFeed({
    items: [{ ...question, children: [{ ...question, nodeId: "child", parentNodeId: "node", prompt: "Follow up question here" }] }],
    researchTrees: [{ ...tree, followed: true, bookmarked: true }],
  });
  const footer = html.indexOf('class="research-feed-post-footer"');
  assert.ok(html.indexOf("Summary: The finding is X.") < footer);
  assert.ok(footer < html.indexOf("research-feed-post-time"));
  assert.ok(html.indexOf("research-feed-post-time") < html.indexOf('aria-label="Open 1 follow-up">1 follow-up</button>'));
  assert.ok(html.indexOf('aria-label="Open 1 follow-up"') < html.indexOf("research-thread-actions"));
  assert.ok(html.indexOf("research-thread-follow") < html.indexOf("research-thread-bookmark"));
  assert.match(html, /research-thread-follow is-active"[^>]*aria-pressed="true"[^>]*>Following<\/button>/);
  assert.match(html, /research-thread-bookmark is-active"[^>]*aria-pressed="true"[^>]*aria-label="Remove bookmark"/);
  // A question reads as one by its title and summary; only conversations
  // carry a kind glyph.
  assert.doesNotMatch(html, /research-feed-post-kind/);
  // Follow-ups are counted, not listed; only the root item is a feed row.
  assert.doesNotMatch(html, /Follow up question here/);
  assert.equal((html.match(/aria-posinset=/g) ?? []).length, 1);

  const unflagged = renderFeed({ items: [question], researchTrees: [tree] });
  assert.match(unflagged, /research-thread-follow"[^>]*aria-pressed="false"[^>]*>Follow<\/button>/);
  assert.match(unflagged, /aria-label="Bookmark"/);
  assert.doesNotMatch(unflagged, /research-feed-post-count/);
});

test("a post that is still answering shows its status without time, Follow or Bookmark", () => {
  const html = renderFeed({
    items: [{ ...question, status: "running" as const, recap: null }],
    researchTrees: [tree],
  });
  assert.match(html, /research-feed-post-status" role="status"/);
  assert.match(html, /Generating answer/);
  assert.doesNotMatch(html, /research-thread-actions/);
  assert.doesNotMatch(html, /<time/);
});

test("the open thread's post is selected and unread posts carry a dot", () => {
  const html = renderFeed({
    items: [question, { ...question, nodeId: "other-node", treeId: "other", prompt: "Other question" }],
    researchTrees: [
      { ...tree, hasUnseenUpdate: true },
      { ...tree, id: "other", rootNodeId: "other-node", hasUnseenUpdate: true },
    ],
    selectedTreeId: "tree",
  });
  assert.equal((html.match(/research-feed-post is-selected/g) ?? []).length, 1);
  assert.match(html, /aria-current="true"/);
  // Selecting a thread reads it, so only the other post keeps its dot.
  const posts = html.split(/class="research-feed-post(?=[ "])/).slice(1);
  const selected = posts.find((post) => post.startsWith(" is-selected"));
  const other = posts.find((post) => post.includes("Other question"));
  assert.ok(selected && !selected.includes("research-feed-post-unread"));
  assert.ok(other?.includes("research-feed-post-unread"));
});

test("a thread that failed since it was viewed shows the failure marker instead of the dot", () => {
  const html = renderFeed({
    items: [question, { ...question, nodeId: "other-node", treeId: "other", prompt: "Other question" }],
    researchTrees: [
      { ...tree, hasUnseenUpdate: true, hasUnseenFailure: true },
      { ...tree, id: "other", rootNodeId: "other-node", hasUnseenUpdate: true, hasUnseenFailure: true },
    ],
    selectedTreeId: "tree",
  });
  const posts = html.split(/class="research-feed-post(?=[ "])/).slice(1);
  const selected = posts.find((post) => post.startsWith(" is-selected"));
  const other = posts.find((post) => post.includes("Other question"));
  // The open thread acknowledges its failure, so only the other post is marked.
  assert.ok(selected && !selected.includes("research-feed-post-failed"));
  assert.ok(other?.includes('class="research-feed-post-marker research-feed-post-failed"'));
  assert.ok(other && !other.includes("research-feed-post-unread"));
});

test("an exported conversation lists as a titled post with a terminal glyph", () => {
  const html = renderFeed({
    items: [{ ...question, kind: "conversation" as const, recap: null, prompt: "First user message" }],
    researchTrees: [{ ...tree, kind: "conversation" as const, title: "Terminal session" }],
  });
  assert.equal((html.match(/class="research-feed-post"/g) ?? []).length, 1);
  assert.match(html, /research-feed-post-title">Terminal session</);
  assert.match(html, /First user message/);
  assert.match(html, /research-feed-post-kind"><svg[^>]*lucide-terminal/);
});

test("only one post of the open thread is selected", () => {
  // A thread's follow-up is its own post; the thread's newest post is the one
  // selected when the thread was opened from elsewhere.
  const followUp = {
    ...question, nodeId: "follow", parentNodeId: "node", prompt: "A later follow-up", createdAt: 200,
  };
  const html = renderFeed({ items: [followUp, question], researchTrees: [tree], selectedTreeId: "tree" });
  assert.equal((html.match(/research-feed-post is-selected/g) ?? []).length, 1);
  const selected = html.split(/class="research-feed-post(?=[ "])/).find((post) => post.startsWith(" is-selected"));
  assert.ok(selected?.includes("A later follow-up"));
});

test("a saved link opens from its time, and a count opens its follow-ups", () => {
  const html = renderFeed({
    items: [{ ...savedLink, children: [{ ...question, nodeId: "child", parentNodeId: "link", createdAt: 300 }] }],
  });
  // An untitled post's time is its keyboard control; a titled post uses its title.
  assert.match(html, /class="control-button research-feed-post-time" aria-label="Open post"><time/);
  assert.match(html, /class="control-button research-feed-post-count" tabindex="-1" aria-label="Open 1 follow-up"/);
  const titled = renderFeed({ items: [question], researchTrees: [tree], selectedTreeId: "tree" });
  assert.match(titled, /<button type="button" class="control-button research-feed-post-title" aria-current="true">Investigate<\/button>/);
  assert.match(titled, /class="control-button research-feed-post-time" tabindex="-1"><time/);
  assert.doesNotMatch(titled, /role="button"/);
});

test("posts render Markdown links and hold the summary slot while one generates", () => {
  const withLink = renderFeed({
    items: [{
      ...question,
      prompt: "what would solving it this way look like?\nhttps://x.com/example/status/2097801834224312595",
    }],
  });
  assert.match(withLink, /turn-markdown/);
  assert.match(withLink, /href="https:\/\/x\.com\/example\/status\/2097801834224312595"/);

  const pending = renderFeed({
    items: [{ ...question, recap: null }],
    recapPendingNodeIds: new Set(["node"]),
  });
  assert.match(pending, /Generating summary/);
  const generated = renderFeed({ items: [question], recapPendingNodeIds: new Set(["node"]) });
  assert.match(generated, /Summary: The finding is X\./);
  assert.doesNotMatch(generated, /Generating summary/);
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


test("Home offers report import", () => {
  const html = renderFeed({ onImportReport: asyncNoop, items: [{
    nodeId: "import", treeId: "import-tree", inline: false, prompt: "Original prompt",
    adapter: "codex", model: null, origin: "imported", status: "complete", createdAt: 100,
  }] });
  assert.match(html, /aria-label="Import \.md report"/);
  assert.ok(html.indexOf('aria-label="Refresh Home"') < html.indexOf('aria-label="Import .md report"'));
  assert.match(html, /accept=".md,text\/markdown"/);
  assert.doesNotMatch(renderFeed({ view: "bookmarks", onImportReport: asyncNoop }), /Import \.md report/);
});

function networkNote(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "note", treeId: "note-tree", parentNodeId: null, inline: false,
    prompt: "Who ships component-model plugins?", adapter: "claude", model: "fable",
    kind: "note" as const, status: "complete" as const, createdAt: 100,
    delivery: { status: "posted" as const, postedAt: 100 },
    ...overrides,
  };
}

test("a network note is a post that counts its replies and follow-ups", () => {
  const html = renderFeed({ items: [networkNote({
    replyCount: 7,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{ id: "r1", author: { kind: "member", id: "ana", displayName: "Ana Moreau", handle: "ana" }, body: "We moved in March.", createdAt: 110 }],
    },
    children: [
      { ...networkNote(), nodeId: "ai", parentNodeId: "note", kind: "run", delivery: null,
        prompt: "Does wasmtime support async?", status: "complete", createdAt: 130 },
    ],
  })] });
  assert.match(html, /Who ships component-model plugins\?/);
  assert.match(html, /aria-label="Open 7 replies">7 replies<\/button>/);
  assert.match(html, /aria-label="Open 1 follow-up">1 follow-up<\/button>/);
  // A note has no kind glyph; its footer starts with the time.
  assert.doesNotMatch(html, /research-feed-post-kind/);
  // Replies and follow-ups open with the note; the post only counts them.
  assert.doesNotMatch(html, /We moved in March\./);
  assert.doesNotMatch(html, /Does wasmtime support async\?/);
  assert.doesNotMatch(html, /No replies yet/);
  assert.doesNotMatch(html, /research-feed-post-title/);

  assert.deepEqual(feedPostCounts(networkNote()), []);
  assert.deepEqual(feedPostCounts({ ...networkNote(), kind: "run", replyCount: 4 }), []);
  assert.deepEqual(feedPostCounts(networkNote({ replyCount: 1 })), ["1 reply"]);
});
