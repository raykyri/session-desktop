import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, {
  recentActivityAnchorOffset,
  recentActivityAnchorScrollTop,
  researchFeedStatus,
  type ResearchActivityFeedProps,
} from "../src/components/research/ResearchActivityFeed";
import type { ResearchFolderState } from "../src/types";

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
    onRenameResearch: asyncNoop,
    onRestoreResearch: asyncNoop, onRemoveResearch: asyncNoop,
    onSetResearchBookmarked: noop,
    onMoveTree: noop,
    onLoadOlder: noop,
    onRefresh: noop, onBack: noop, onForward: noop,
    ...overrides,
  }));
}

const tree = {
  id: "tree", title: "Collective memory", rootNodeId: "node", kind: "run" as const, workspaceId: "ws",
  runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 100,
  archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false,
};
const question = {
  nodeId: "node", treeId: "tree", parentNodeId: null, inline: false,
  prompt: "Investigate this question", adapter: "codex", status: "complete" as const,
  createdAt: 100, recap: "The finding is X.",
};
const folders: ResearchFolderState = {
  folders: [{ id: "f-read", name: "Reading list", workspaceId: "ws" }],
  membership: {},
  starred: [],
  collapsed: [],
};

const cards = (html: string) => html.split(/class="research-feed-card(?=[ "])/).slice(1);

test("Home starts with the composer, then lists Unfiled cards, then the trays; a card shows the title when it differs, then the question", () => {
  const html = renderFeed({ items: [savedLink, question], researchTrees: [tree] });
  assert.match(html, /research-feed-header-title[^>]*>Home</);
  assert.match(html, /role="feed"/);
  assert.match(html, /research-reading-surface/);
  assert.equal(cards(html).length, 2);
  assert.match(html, /note-link-card research-content-card/);
  assert.match(html, /research-user-message research-feed-card-message/);
  assert.match(html, /Query composer/);
  // The ask box starts Home, before the Unfiled list; Home's header has no
  // + Ask, and its header marks Home for the collapsed sidebar.
  assert.ok(html.indexOf("Query composer") < html.indexOf("research-feed-card"));
  assert.ok(html.indexOf("research-feed-card") < html.indexOf("research-feed-tray"));
  assert.doesNotMatch(html, /aria-label="Go to the ask box"/);
  assert.match(html, /class="research-feed-header is-home"/);
  assert.ok(html.indexOf("research-feed-card-title\">Collective memory<") > 0);
  assert.ok(
    html.indexOf("research-feed-card-title\">Collective memory<") <
      html.indexOf("research-feed-card-question\">Investigate this question<"),
  );
  assert.match(html, /aria-label="Refresh Home"/);
  // Unfiled is a drop target for moving questions back from any folder.
  assert.match(html, /data-research-drop="system:unfiled"/);
  assert.doesNotMatch(html, /<iframe|View source|Connecting to/);
});

test("cards have no metadata row: no time, counts, summary, Follow or Bookmark", () => {
  const html = renderFeed({
    items: [{ ...question, children: [{ ...question, nodeId: "child", parentNodeId: "node", prompt: "Follow up question here" }] }],
    researchTrees: [{ ...tree, followed: true, bookmarked: true }],
  });
  assert.doesNotMatch(html, /<time|research-thread-actions|Summary: |follow-up<\/button>/);
  // Direct follow-ups are not rows of their own unless starred.
  assert.doesNotMatch(html, /Follow up question here/);
  // Bookmarking and moving live in the card's … menu.
  assert.match(html, /title="Bookmark, follow or move" aria-label="Bookmark, follow or move" aria-haspopup="menu"/);
  // A title that only repeats the question is not shown above it.
  const echoed = renderFeed({
    items: [question],
    researchTrees: [{ ...tree, title: "Investigate this question" }],
  });
  assert.doesNotMatch(echoed, /research-feed-card-title/);
});

test("running and failed threads show a status dot; unread threads a dot unless open", () => {
  const html = renderFeed({
    items: [
      { ...question, status: "running" as const },
      { ...question, nodeId: "failed-node", treeId: "failed", prompt: "Failed question" },
      { ...question, nodeId: "other-node", treeId: "other", prompt: "Other question" },
    ],
    researchTrees: [
      { ...tree, hasUnseenUpdate: true },
      { ...tree, id: "failed", rootNodeId: "failed-node", hasUnseenFailure: true },
      { ...tree, id: "other", rootNodeId: "other-node", hasUnseenUpdate: true },
    ],
    selectedTreeId: "tree",
  });
  const [running, failed, other] = ["Investigate this question", "Failed question", "Other question"].map(
    (text) => cards(html).find((card) => card.includes(text)) ?? "",
  );
  assert.match(running, /research-feed-status is-running/);
  assert.match(running, /aria-label="Collective memory\. Investigate this question, Running"/);
  assert.ok(running.startsWith(" is-selected"));
  // Selecting a thread reads it, so only the other card keeps its dot.
  assert.doesNotMatch(running, /research-feed-card-unread/);
  assert.match(other, /research-feed-card-unread/);
  assert.match(failed, /research-feed-status is-failed/);
  assert.match(failed, /aria-label="Collective memory\. Failed question, Failed since last viewed"/);

  // A failure dot replaces the unread dot rather than joining it.
  const both = renderFeed({
    items: [{ ...question, prompt: "Failed question" }],
    researchTrees: [{ ...tree, hasUnseenUpdate: true, hasUnseenFailure: true }],
  });
  assert.match(both, /research-feed-status is-failed/);
  assert.doesNotMatch(both, /research-feed-card-unread/);

  assert.equal(researchFeedStatus({ ...tree, runningCount: 1 }, question), "running");
  assert.equal(researchFeedStatus(tree, { ...question, status: "failed" }), "failed");
  assert.equal(researchFeedStatus(tree, question), null);
});

test("starred follow-ups and branches are indented rows under their question", () => {
  const html = renderFeed({
    items: [{
      ...question,
      promoted: [
        { ...question, nodeId: "follow", parentNodeId: "node", inline: true, prompt: "A starred follow-up", branchDepth: 0 },
        { ...question, nodeId: "branch", parentNodeId: "node", inline: false, prompt: "Branch prompt", title: "Branch title", branchDepth: 1 },
        { ...question, nodeId: "deep", parentNodeId: "branch", inline: false, prompt: "Deep", branchDepth: 3, status: "running" as const },
      ],
    }],
    researchTrees: [tree],
    onDragStart: noop,
  });
  const rows = html
    .split(/class="research-feed-child(?=[ "])/)
    .slice(1)
    .map((row) => row.slice(0, row.indexOf("</div>")));
  assert.equal(rows.length, 3);
  assert.ok(rows[0].startsWith(" is-group-start"));
  assert.match(rows[0], /--research-child-level:1/);
  // A follow-up has no icon; a starred branch is marked with a filled star.
  assert.doesNotMatch(rows[0], /Starred branch: |research-feed-child-icon/);
  assert.match(rows[1], /<svg(?=[^>]*lucide-star)(?=[^>]*fill="currentColor")/);
  assert.match(rows[1], /Starred branch: <\/span><span class="research-feed-child-text">Branch title</);
  // Levels cap at two; running children keep a status dot.
  assert.match(rows[2], /--research-child-level:2/);
  assert.ok(rows[2].startsWith(" is-group-end"));
  assert.match(rows[2], /research-feed-status is-running/);
  // Each child row has its open target and, in the right-hand margin, the
  // drag handle above a … menu.
  for (const row of rows) {
    assert.equal((row.match(/<button/g) ?? []).length, 2);
    assert.match(
      row,
      /class="research-feed-rail"><span class="research-feed-card-grip"[^]*class="research-feed-icon-button research-feed-card-menu" title="Remove the star, bookmark, follow or move"/,
    );
  }
  assert.equal((html.match(/class="research-feed-child-open"/g) ?? []).length, 3);
  // The question row has the same margin.
  assert.match(html, /class="research-feed-rail"><span class="research-feed-card-grip"[^]*title="Bookmark, follow or move"/);

  // The open nodes' rows are marked (a follow-up whose message is selected
  // in the root pair, an open branch); other cards' rows are not.
  const promoted = [
    { ...question, nodeId: "follow", parentNodeId: "node", inline: true, prompt: "A starred follow-up", branchDepth: 0 },
    { ...question, nodeId: "branch", parentNodeId: "node", inline: false, prompt: "Branch prompt", branchDepth: 1 },
  ];
  const open = renderFeed({
    items: [{ ...question, promoted }],
    researchTrees: [tree],
    selectedTreeId: "tree",
    selectedChildNodeIds: ["follow", "branch"],
  });
  assert.match(open, /research-feed-child is-group-start is-selected"[^]*?aria-current="true"><span class="research-feed-child-text">A starred follow-up/);
  assert.match(open, /research-feed-child is-group-end is-selected"[^]*?aria-current="true"><svg/);
  assert.match(open, /research-feed-card is-selected/);
  const elsewhere = renderFeed({
    items: [{ ...question, promoted }],
    researchTrees: [tree],
    selectedChildNodeIds: ["follow", "branch"],
  });
  assert.doesNotMatch(elsewhere, /is-selected/);
});

test("Home lists filed questions in their folder's tray, after Unfiled", () => {
  const filed = { ...question, nodeId: "filed-node", treeId: "filed", prompt: "Filed question" };
  const drafted = { ...question, nodeId: "drafted-node", treeId: "drafted", prompt: "Drafted tree" };
  const html = renderFeed({
    items: [question, filed, drafted],
    researchTrees: [
      tree,
      { ...tree, id: "filed", rootNodeId: "filed-node" },
      { ...tree, id: "drafted", rootNodeId: "drafted-node" },
      { ...tree, id: "gone", title: "Archived thread", archivedAt: 5 },
    ],
    folders: folders.folders,
    folderState: {
      ...folders,
      membership: { filed: "f-read", drafted: "system:drafts" },
      collapsed: ["system:archive"],
    },
    drafts: [{ id: "d1", workspaceId: "ws", prompt: "An unsent draft", createdAt: 1, updatedAt: 1 }],
  });
  const trays = html.split(/class="research-feed-tray(?=[ "])/).slice(1);
  assert.deepEqual(
    trays.map((tray) => tray.match(/aria-label="([^"]+)"/)?.[1]),
    ["Drafts", "Reading list", "Archive"],
  );
  assert.ok(html.indexOf("Investigate this question") < html.indexOf('aria-label="Drafts"'));
  assert.match(trays[0], /An unsent draft[\s\S]*Drafted tree/);
  assert.match(trays[1], /data-research-drop="f-read"/);
  assert.match(trays[1], /Filed question/);
  // Filed questions leave Unfiled.
  assert.equal((html.match(/Filed question/g) ?? []).length, 2);
  // The collapsed Archive tray keeps its header and drop target, not its cards.
  assert.ok(trays[2].startsWith(" is-collapsed"));
  assert.match(trays[2], /data-research-tray-collapsed=""/);
  assert.doesNotMatch(trays[2], /Archived thread/);
  assert.match(trays[2], /aria-expanded="false" aria-label="Expand Archive"/);
  // Each header counts the folder's questions, with words for screen readers
  // so the name doesn't run into the number.
  assert.match(trays[0], /research-feed-tray-count">2<span class="research-visually-hidden"> questions<\/span>/);
  assert.match(trays[1], /research-feed-tray-count">1<span class="research-visually-hidden"> question<\/span>/);
  assert.match(trays[2], /research-feed-tray-count">1</);
});

test("a folder view names the folder and lists only its questions", () => {
  const html = renderFeed({
    view: { kind: "folder", folderId: "f-read" },
    items: [question],
    researchTrees: [tree],
    folders: folders.folders,
    folderState: folders,
  });
  assert.match(html, /aria-label="Back to Home"/);
  assert.match(html, /research-feed-header-title[^>]*>Reading list</);
  assert.match(html, /aria-label="Rename folder"/);
  assert.match(html, /aria-label="Delete folder"/);
  assert.doesNotMatch(html, /Investigate this question/);
  assert.match(html, /Empty folder\. Drag or file questions here\./);
  assert.match(html, /data-research-drop="f-read"/);

  const confirm = renderFeed({
    view: { kind: "folder", folderId: "f-read" },
    researchTrees: [tree],
    folders: folders.folders,
    folderState: { ...folders, membership: { tree: "f-read" } },
    pendingDeleteFolderId: "f-read",
  });
  assert.match(confirm, /Delete “Reading list”\? Its 1 question moves to Unfiled\./);
});

test("Drafts lists unsent drafts, then trees filed in Drafts", () => {
  const html = renderFeed({
    view: { kind: "drafts" },
    researchTrees: [tree],
    folderState: { ...folders, membership: { tree: "system:drafts" } },
    drafts: [{ id: "d1", workspaceId: "ws", prompt: "An unsent draft", createdAt: 1, updatedAt: 1 }],
  });
  assert.match(html, /research-feed-header-title[^>]*>Drafts</);
  assert.match(html, /data-research-card="d1" data-research-card-kind="draft"/);
  assert.ok(html.indexOf("An unsent draft") > 0);
  assert.ok(html.indexOf("An unsent draft") < html.indexOf("Collective memory"));
  const empty = renderFeed({ view: { kind: "drafts" } });
  assert.match(empty, /No drafts\. Use Save draft in the composer to keep a question for later\./);
});

test("a draft card opens in the content column and has Open and Delete in its … menu", () => {
  const html = renderFeed({
    drafts: [{ id: "d1", workspaceId: "ws", prompt: "An unsent draft", createdAt: 1, updatedAt: 1 }],
    selectedDraftId: "d1",
  });
  const [card] = cards(html).filter((entry) => entry.includes('data-research-card="d1"'));
  assert.ok(card.startsWith(" is-selected"));
  assert.match(card, /aria-label="Draft: An unsent draft" aria-current="true"/);
  assert.match(card, /title="Draft actions" aria-label="Draft actions" aria-haspopup="menu"/);
  // No inline editor in the feed.
  assert.doesNotMatch(html, /<textarea|Draft · Not sent/);
});

test("Home with only drafts says Unfiled is empty instead of the first-run text", () => {
  const html = renderFeed({
    drafts: [{ id: "d1", workspaceId: "ws", prompt: "An unsent draft", createdAt: 1, updatedAt: 1 }],
    setupGuide: createElement("div", null, "Agent setup guide"),
  });
  assert.match(html, /Nothing unfiled\. New questions land here\./);
  assert.doesNotMatch(html, /Agent setup guide|appear here, newest first/);
});

test("an exported conversation lists as a titled card", () => {
  const html = renderFeed({
    items: [{ ...question, kind: "conversation" as const, recap: null, prompt: "First user message" }],
    researchTrees: [{ ...tree, kind: "conversation" as const, title: "Terminal session" }],
  });
  assert.equal(cards(html).length, 1);
  assert.match(html, /research-feed-card-title">Terminal session</);
  assert.match(html, /First user message/);
});

test("an imported report lists as a titled card with its question, in Home and in Archive", () => {
  const imported = {
    ...question, kind: "document" as const, origin: "imported" as const, recap: null,
    prompt: "What did the survey find?",
  };
  const importedTree = { ...tree, kind: "document" as const, title: "Survey report" };
  const html = renderFeed({ items: [imported], researchTrees: [importedTree] });
  assert.equal(cards(html).length, 1);
  assert.match(html, /research-feed-card-title">Survey report</);
  assert.match(html, /What did the survey find\?/);
  // An imported document prevents Home from showing the first-run text.
  assert.doesNotMatch(html, /appear here, newest first/);
  const archived = renderFeed({
    view: { kind: "archive" },
    researchTrees: [{ ...importedTree, archivedAt: 300 }],
  });
  assert.match(archived, /Survey report/);
});

test("one card per thread, even when a follow-up item is loaded", () => {
  const followUp = {
    ...question, nodeId: "follow", parentNodeId: "node", prompt: "A later follow-up", createdAt: 200,
  };
  const html = renderFeed({ items: [followUp, question], researchTrees: [tree], selectedTreeId: "tree" });
  assert.equal(cards(html).length, 1);
  assert.equal((html.match(/research-feed-card is-selected/g) ?? []).length, 1);
  assert.match(html, /Investigate this question/);
});

test("cards show the question as plain text; its Markdown renders in the conversation", () => {
  const withLink = renderFeed({
    items: [{
      ...question,
      prompt: "what would **solving** it look like?\nhttps://x.com/example/status/2097801834224312595",
    }],
  });
  assert.doesNotMatch(withLink, /turn-markdown|<a |<strong>/);
  assert.match(
    withLink,
    /research-feed-card-question">what would \*\*solving\*\* it look like\?\nhttps:\/\/x\.com\/example\/status\/2097801834224312595</,
  );
});

test("the Bookmarks view lists only bookmarked threads, archived ones last", () => {
  const query = { nodeId: "node", treeId: "tree", parentNodeId: null, inline: false, prompt: "Bookmarked question", adapter: "codex", status: "complete" as const, createdAt: 100 };
  const other = { ...query, nodeId: "other-node", treeId: "other", prompt: "Unbookmarked question" };
  const bookmarked = { ...tree, bookmarked: true };
  const items = [
    { ...savedLink, prompt: "https://example.com/saved", createdAt: 300 },
    other,
    query,
  ];
  const html = renderFeed({
    view: { kind: "bookmarks" },
    items,
    researchTrees: [
      bookmarked,
      { ...tree, id: "other", rootNodeId: "other-node", bookmarked: false },
      { ...bookmarked, id: "archived", title: "Archived bookmark", archivedAt: 9 },
    ],
    setupGuide: createElement("div", null, "Setup guide"),
  });
  assert.match(html, /research-feed-header-title[^>]*>Bookmarks</);
  assert.match(html, /aria-label="Refresh Bookmarks"/);
  assert.match(html, /Bookmarked question/);
  assert.ok(html.indexOf("Bookmarked question") > 0);
  assert.ok(html.indexOf("Bookmarked question") < html.indexOf("Archived bookmark"));
  assert.doesNotMatch(html, /Unbookmarked question/);
  assert.doesNotMatch(html, /example.com\/saved/);
  assert.doesNotMatch(html, /Setup guide/);

  const empty = renderFeed({ view: { kind: "bookmarks" }, items, researchTrees: [tree] });
  assert.match(empty, /No bookmarks\. Choose Bookmark in a question&#x27;s … menu to keep it here\./);

  const home = renderFeed({ items, researchTrees: [bookmarked] });
  assert.match(home, /Unbookmarked question/);

  // Bookmarks follow the folders' (flat tree) order, not recency.
  const ordered = renderFeed({
    view: { kind: "bookmarks" },
    items: [
      { ...query, treeId: "tree", prompt: "Older but first", createdAt: 100 },
      { ...query, nodeId: "n2", treeId: "second", prompt: "Newer but second", createdAt: 500 },
    ],
    researchTrees: [bookmarked, { ...bookmarked, id: "second", rootNodeId: "n2" }],
  });
  assert.ok(ordered.indexOf("Older but first") < ordered.indexOf("Newer but second"));
});

test("feed pagination errors remain visible", () => {
  const html = renderFeed({
    nextCursor: { createdAt: 100, nodeId: "link" },
    olderError: "Temporarily unavailable",
  });
  assert.match(html, /Retry older activity/);
  assert.match(html, /Temporarily unavailable/);
});

test("the agent setup guide appears only when the Home feed is empty", () => {
  const setupGuide = createElement("div", null, "Agent setup guide");

  const emptyWithGuide = renderFeed({ setupGuide });
  assert.match(emptyWithGuide, /Agent setup guide/);
  assert.doesNotMatch(emptyWithGuide, /appear here, newest first/);
  assert.match(renderFeed({}), /appear here, newest first/);
  assert.doesNotMatch(renderFeed({ setupGuide, items: [savedLink] }), /Agent setup guide/);
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
  assert.doesNotMatch(renderFeed({ view: { kind: "bookmarks" }, onImportReport: asyncNoop }), /Import \.md report/);
});

test("a network note is an untitled card showing its body", () => {
  const html = renderFeed({ items: [{
    nodeId: "note", treeId: "note-tree", parentNodeId: null, inline: false,
    prompt: "Who ships component-model plugins?", adapter: "claude", model: "fable",
    kind: "note" as const, status: "complete" as const, createdAt: 100,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{ id: "r1", author: { kind: "member", id: "ana", displayName: "Ana Moreau", handle: "ana" }, body: "We moved in March.", createdAt: 110 }],
    },
    replyCount: 7,
  }] });
  assert.match(html, /Who ships component-model plugins\?/);
  assert.doesNotMatch(html, /research-feed-card-title/);
  // Replies open with the note; the card shows only the question.
  assert.doesNotMatch(html, /We moved in March\.|7 replies/);
});
