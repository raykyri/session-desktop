import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, {
  feedRowOpenKey,
  recentActivityAnchorOffset,
  recentActivityAnchorScrollTop,
  type ResearchActivityFeedProps,
} from "../src/components/research/ResearchActivityFeed";
import { researchFolderDeleteDialogProps } from "../src/components/research/ResearchFolderDialogs";
import { ResearchDeleteDialogPanel } from "../src/components/research/ResearchDeleteDialog";
import { researchTrashEntries } from "../src/lib/researchTrash";
import type { ResearchFolderState } from "../src/types";

const noop = () => {};
const asyncNoop = async () => {};
const savedLink = {
  nodeId: "link", treeId: "link-tree", parentNodeId: null, inline: false,
  prompt: "https://example.com/finding", adapter: "codex", type: "post" as const,
  format: "link" as const,
  status: "complete" as const, createdAt: 200,
};

function renderFeed(overrides: Partial<ResearchActivityFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchActivityFeed, {
    composer: createElement("div", null, "Query composer"),
    items: [], researchTrees: [],
    onOpenResearchQuery: noop,
    onResearchRecapApplied: noop, onError: noop,
    onRenameResearch: asyncNoop,
    onRestoreResearch: asyncNoop, onTrashResearch: asyncNoop, onRemoveResearch: asyncNoop,
    onMoveTree: noop,
    onRefresh: noop, onBack: noop, onForward: noop,
    ...overrides,
  }));
}

const tree = {
  id: "tree", title: "Collective memory", rootNodeId: "node", type: "exchange" as const, workspaceId: "ws",
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
  collapsed: [],
  parents: {},
  collapsedGroups: [],
};

const cards = (html: string) => html.split(/class="research-feed-card(?=[ "])/).slice(1);

test("Home starts with the composer, then lists Unfiled cards, then the trays; a card shows the title when it differs, then the question", () => {
  const html = renderFeed({ items: [savedLink, question], researchTrees: [tree] });
  assert.match(html, /research-feed-header-title[^>]*>Home</);
  assert.match(html, /role="feed"/);
  assert.match(html, /research-reading-surface/);
  assert.equal(cards(html).length, 2);
  assert.match(html, /post-link-card research-content-card/);
  assert.match(html, /research-user-message research-feed-card-message/);
  assert.match(html, /Query composer/);
  // The ask box starts Home, before the Unfiled list; the header has no
  // + Ask, and it marks Home for the collapsed sidebar.
  assert.ok(html.indexOf("Query composer") < html.indexOf("research-feed-card"));
  assert.ok(html.indexOf("research-feed-card") < html.indexOf("research-feed-tray"));
  assert.doesNotMatch(html, /aria-label="Go to the ask box"/);
  assert.match(html, /class="research-feed-header is-home"/);
  assert.ok(html.indexOf("Collective memory<") > 0);
  assert.ok(
    html.indexOf("Collective memory<") <
      html.indexOf("Investigate this question<"),
  );
  assert.match(html, /aria-label="Refresh Home"/);
  // Unfiled is a drop target for moving questions back from any folder.
  assert.match(html, /data-research-drop="system:unfiled"/);
  assert.doesNotMatch(html, /<iframe|View source|Connecting to/);
});

test("cards have no metadata row: no time, counts or recap", () => {
  const html = renderFeed({
    items: [{ ...question, children: [{ ...question, nodeId: "child", parentNodeId: "node", prompt: "Follow up question here" }] }],
    researchTrees: [tree],
  });
  assert.doesNotMatch(html, /<time|research-thread-actions|Recap: |follow-up<\/button>/);
  // Follow-ups are not rows of their own.
  assert.doesNotMatch(html, /Follow up question here/);
  // Moving and the thread's actions live in the card's … menu,
  // which its context menu also opens.
  assert.match(html, /title="Thread actions" aria-label="Thread actions" aria-haspopup="menu"/);
  // A title that only repeats the question is not shown above it.
  const echoed = renderFeed({
    items: [question],
    researchTrees: [{ ...tree, title: "Investigate this question" }],
  });
  assert.doesNotMatch(echoed, /research-feed-card-title/);
});

/** The glyph a card or row starts with: its shape class, and its name when
 * it has one. */
const glyphOf = (html: string) =>
  html.match(/<span (?:id="[^"]*" )?class="research-row-glyph is-([a-z]+)[^"]*"(?: role="img" aria-label="([^"]+)")?/)?.slice(1, 3) ?? [];

test("a card's glyph shows the thread's state; unread threads show the unread glyph unless open", () => {
  const html = renderFeed({
    items: [
      { ...question, status: "running" as const },
      { ...question, nodeId: "failed-node", treeId: "failed", prompt: "Failed question" },
      { ...question, nodeId: "other-node", treeId: "other", prompt: "Other question" },
      { ...question, nodeId: "queued-node", treeId: "queued", prompt: "Queued question", status: "queued" as const },
      { ...question, nodeId: "stopped-node", treeId: "stopped", prompt: "Stopped question", status: "cancelled" as const },
      { ...question, nodeId: "read-node", treeId: "read", prompt: "Read question" },
    ],
    researchTrees: [
      { ...tree, hasUnseenUpdate: true },
      { ...tree, id: "failed", rootNodeId: "failed-node", hasUnseenFailure: true },
      { ...tree, id: "other", rootNodeId: "other-node", hasUnseenUpdate: true },
      { ...tree, id: "queued", rootNodeId: "queued-node" },
      { ...tree, id: "stopped", rootNodeId: "stopped-node" },
      { ...tree, id: "read", rootNodeId: "read-node" },
    ],
    selectedTreeId: "tree",
  });
  const card = (text: string) => cards(html).find((entry) => entry.includes(text)) ?? "";
  const running = card("Investigate this question");
  assert.deepEqual(glyphOf(running), ["running", "Running"]);
  assert.ok(running.startsWith(" is-selected"));
  // The state names the glyph, which describes the open button.
  const glyphId = running.match(/<span id="([^"]+)" class="research-row-glyph/)?.[1];
  assert.ok(glyphId);
  assert.match(running, new RegExp(`aria-label="Collective memory\\. Investigate this question" aria-describedby="${glyphId}"`));
  // Selecting a thread reads it, so only the other card shows as unread.
  assert.deepEqual(glyphOf(card("Other question")), ["unread", "Updated"]);
  assert.deepEqual(glyphOf(card("Failed question")), ["failed", "Failed since last viewed"]);
  assert.deepEqual(glyphOf(card("Queued question")), ["queued", "Queued"]);
  assert.deepEqual(glyphOf(card("Stopped question")), ["stopped", "Stopped"]);
  // An answered, read thread has a check and nothing to announce.
  const read = card("Read question");
  assert.deepEqual(glyphOf(read), ["answered", undefined]);
  assert.match(read, /class="research-row-glyph is-answered" aria-hidden="true"/);
  assert.doesNotMatch(read, /aria-describedby/);
  // No corner dot, unread dot or float spacer is left.
  assert.doesNotMatch(html, /research-feed-status|research-feed-card-unread/);

  // A failure replaces the unread state rather than joining it.
  const both = renderFeed({
    items: [{ ...question, prompt: "Failed question" }],
    researchTrees: [{ ...tree, hasUnseenUpdate: true, hasUnseenFailure: true }],
  });
  assert.deepEqual(glyphOf(both), ["failed", "Failed since last viewed"]);
});

test("the glyph occupies its own column beside titled, untitled, link and tweet bodies", () => {
  const tweetUrl = "https://x.com/example/status/1";
  const tweet = {
    kind: "tweet" as const, schemaVersion: 1 as const, sourceUrl: tweetUrl, tweetId: "1", placement: "trailing" as const,
    provider: "xSyndication" as const, status: "resolved" as const, attemptedAt: 1, fetchedAt: 1,
    tweet: {
      id: "1", url: tweetUrl, runs: [{ kind: "text" as const, text: "Tweet text" }], partial: false,
      createdAt: "2025-02-02T23:17:00.000Z", author: { name: "Example", handle: "example" }, media: [],
    },
  };
  const html = renderFeed({
    items: [
      question,
      { ...question, nodeId: "untitled-node", treeId: "untitled", prompt: "Untitled question" },
      savedLink,
      { ...savedLink, nodeId: "note", treeId: "note-tree", prompt: "A note", format: "text" as const },
      { ...savedLink, nodeId: "x", treeId: "x-tree", prompt: tweetUrl, attachments: [tweet] },
    ],
    researchTrees: [
      tree,
      { ...tree, id: "untitled", rootNodeId: "untitled-node", title: "Untitled question" },
      { ...tree, id: "link-tree", rootNodeId: "link", type: "post" as const },
      { ...tree, id: "note-tree", rootNodeId: "note", type: "post" as const },
      { ...tree, id: "x-tree", rootNodeId: "x", type: "post" as const },
      { ...tree, id: "unloaded", rootNodeId: "missing", title: "Not loaded yet", runningCount: 1 },
    ],
  });
  const card = (text: string) => cards(html).find((entry) => entry.includes(text)) ?? "";
  const glyph = '<span (?:id="[^"]*" )?class="research-row-glyph[^"]*"[^>]*><svg[^]*?</svg></span>';
  for (const text of ["Investigate this question", "Untitled question", "Not loaded yet", "example.com/finding", "A note", "[Tweet: @example]"]) {
    const entry = card(text);
    assert.match(entry, new RegExp(`<div class="research-feed-card-layout(?: has-title)?">${glyph}<div class="research-feed-card-content">`));
    assert.equal((entry.match(/research-row-glyph /g) ?? []).length, 1);
  }
  assert.match(card("Investigate this question"), /<span class="research-feed-card-title">Collective memory<\/span>/);
  assert.deepEqual(glyphOf(card("Not loaded yet")), ["running", "Running"]);
  assert.deepEqual(glyphOf(card("example.com/finding")), ["link", undefined]);
  assert.deepEqual(glyphOf(card("A note")), ["note", undefined]);
  assert.deepEqual(glyphOf(card("[Tweet: @example]")), ["xpost", undefined]);
  // Home shows the tweet as a label, not its embed.
  assert.doesNotMatch(card("[Tweet: @example]"), /tweet-embed|Tweet text/);
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
    ["Drafts", "Reading list", "Archive", "Trash"],
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
});

test("the folder delete confirmation moves the folder to the Trash, or deletes it now", () => {
  const props = researchFolderDeleteDialogProps({
    name: "Reading list",
    count: 1,
    onTrash: noop,
    onDelete: noop,
    onCancel: noop,
  });
  const html = renderToStaticMarkup(createElement(ResearchDeleteDialogPanel, props));
  assert.match(html, /class="confirm-dialog" role="dialog" aria-modal="true"/);
  assert.match(html, /<h2[^>]*>Delete “Reading list”\?<\/h2>/);
  assert.match(html, /The folder moves to the Trash\. Its 1 question shows in Unfiled until you restore it\./);
  assert.ok(html.indexOf(">Delete now<") < html.indexOf(">Cancel<"));
  assert.ok(html.indexOf(">Cancel<") < html.indexOf(">Move to Trash<"));
  const now = renderToStaticMarkup(
    createElement(ResearchDeleteDialogPanel, { ...props, initialStep: "remove" }),
  );
  assert.match(now, /Delete permanently\?/);
  assert.match(now, /Its 1 question moves to Unfiled\. This can’t be undone\./);
  const empty = researchFolderDeleteDialogProps({
    name: "Empty", count: 0, onTrash: noop, onDelete: noop, onCancel: noop,
  });
  assert.match(
    renderToStaticMarkup(createElement(ResearchDeleteDialogPanel, empty)),
    /The folder is empty\. It moves to the Trash\./,
  );
});

const trashedTree = { ...tree, id: "gone", title: "Old thread", trashedAt: 20 };
const trashEntries = researchTrashEntries(
  [trashedTree],
  [{ id: "f-old", name: "Old folder", workspaceId: "ws", trashedAt: 30 }],
  "ws",
);

test("Home ends with a collapsed Trash tray that counts its items and takes no drops", () => {
  const html = renderFeed({ trashEntries, folderState: folders, folders: folders.folders });
  const trays = html.split(/class="research-feed-tray(?=[ "])/).slice(1);
  const trash = trays[trays.length - 1];
  assert.match(trash, /^ is-collapsed" aria-label="Trash"/);
  assert.doesNotMatch(trash, /data-research-drop/);
  assert.match(trash, /research-feed-tray-count">2<span class="research-visually-hidden"> items<\/span>/);
  assert.match(trash, /aria-expanded="false" aria-label="Expand Trash"/);
  assert.doesNotMatch(trash, /Old thread/);
});

test("Home has a New folder link directly below the Trash tray", () => {
  const html = renderFeed({ trashEntries, onNewFolder: noop });
  const trashTray = html.indexOf('aria-label="Trash"');
  const link = html.indexOf('<button type="button" class="research-feed-new-folder">+ New folder</button>');
  assert.ok(trashTray > 0 && link > trashTray);
  assert.equal(html.slice(trashTray, link).match(/<section/g), null);
  assert.doesNotMatch(renderFeed({ view: { kind: "archive" }, onNewFolder: noop }), /research-feed-new-folder/);
});

test("Trash lists its items newest first with Restore and Delete now, and empties from its header", () => {
  const html = renderFeed({ view: { kind: "trash" }, trashEntries, onEmptyTrash: asyncNoop });
  assert.match(html, /research-feed-header-title[^>]*>Trash</);
  assert.match(html, /aria-label="Back to Home"/);
  assert.match(html, /<button type="button" class="research-feed-button">Empty Trash<\/button>/);
  assert.ok(html.indexOf("Old folder") < html.indexOf("Old thread"));
  assert.match(html, /aria-label="Restore Old thread"/);
  assert.match(html, /aria-label="Delete now: Old folder"/);
  // Trash has no ask box and takes no drops.
  assert.doesNotMatch(html, /Query composer/);
  assert.doesNotMatch(html, /research-feed-solo"[^>]*data-research-drop/);

  const empty = renderFeed({ view: { kind: "trash" }, onEmptyTrash: asyncNoop });
  assert.match(empty, /The Trash is empty\./);
  assert.match(empty, /<button type="button" class="research-feed-button" disabled="">Empty Trash<\/button>/);
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
  assert.match(html, /Nothing unfiled\. New questions appear here\./);
  assert.doesNotMatch(html, /Agent setup guide|appear here\. New ones start at the top/);
});

test("a transcript (an exported conversation) lists as a titled card", () => {
  const html = renderFeed({
    items: [{ ...question, type: "document" as const, source: "transcript" as const, recap: null, prompt: "First user message" }],
    researchTrees: [{ ...tree, type: "document" as const, title: "Terminal session" }],
  });
  assert.equal(cards(html).length, 1);
  assert.match(html, /research-row-glyph is-transcript"[^]*?research-feed-card-title">Terminal session</);
  assert.match(html, /First user message/);
});

test("an imported report lists as a titled card with its question, in Home and in Archive", () => {
  const imported = {
    ...question, type: "document" as const, source: "imported" as const, recap: null,
    prompt: "What did the survey find?",
  };
  const importedTree = { ...tree, type: "document" as const, title: "Survey report" };
  const html = renderFeed({ items: [imported], researchTrees: [importedTree] });
  assert.equal(cards(html).length, 1);
  assert.match(html, /research-row-glyph is-imported"[^]*?research-feed-card-title">Survey report</);
  assert.match(html, /What did the survey find\?/);
  // An imported document prevents Home from showing the first-run text.
  assert.doesNotMatch(html, /appear here\. New ones start at the top/);
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

test("cards show the question as plain text, URLs in the link color but not as links", () => {
  const withLink = renderFeed({
    items: [{
      ...question,
      prompt: "what would **solving** it look like?\nhttps://x.com/example/status/2097801834224312595",
    }],
  });
  assert.doesNotMatch(withLink, /turn-markdown|<a |<strong>/);
  assert.match(
    withLink,
    /research-feed-card-question"><span class="research-feed-preview-text">what would \*\*solving\*\* it look like\?\n<span class="research-feed-url">https:\/\/x\.com\/example\/status\/2097801834224312595<\/span></,
  );
});

test("a question still waiting for its title shows in the clamped preview style; a titled one does not", () => {
  const untitled = renderFeed({ items: [{ ...question, prompt: "First line\n\n\nSecond line" }] });
  assert.match(untitled, /research-feed-card-question"><span class="research-feed-preview-text">First line\nSecond line<\/span>/);
  const titled = renderFeed({ items: [question], researchTrees: [tree] });
  assert.match(titled, /research-feed-card-title/);
  assert.doesNotMatch(titled, /research-feed-preview-text/);
});

test("a note whose first line is a Markdown heading shows that line in the title style", () => {
  const note = { ...savedLink, nodeId: "note", treeId: "note-tree", prompt: "## Wikisim\n\nCompelling demo\n# Not a title", format: "text" as const };
  const html = renderFeed({ items: [note], researchTrees: [{ ...tree, id: "note-tree", rootNodeId: "note", type: "post" as const }] });
  assert.match(html, /<span class="research-feed-card-title research-feed-note-heading">Wikisim<\/span><span class="research-feed-preview-text is-after-heading">Compelling demo\n# Not a title<\/span>/);
  const plain = renderFeed({ items: [{ ...note, prompt: "Wikisim\nCompelling demo" }], researchTrees: [{ ...tree, id: "note-tree", rootNodeId: "note", type: "post" as const }] });
  assert.doesNotMatch(plain, /research-feed-note-heading/);
});

test("Home lists Unfiled trees in the tree order; a card whose root is not loaded shows its title", () => {
  const html = renderFeed({
    items: [
      { ...question, nodeId: "n-old", treeId: "older", prompt: "Older question", createdAt: 50 },
      { ...question, nodeId: "n-new", treeId: "newer", prompt: "Newer question", createdAt: 500 },
    ],
    researchTrees: [
      { ...tree, id: "older", rootNodeId: "n-old" },
      { ...tree, id: "unloaded", rootNodeId: "n-unloaded", title: "Paged-out thread" },
      { ...tree, id: "newer", rootNodeId: "n-new" },
    ],
  });
  const order = ["Older question", "Paged-out thread", "Newer question"].map((text) => html.indexOf(text));
  assert.ok(order.every((index) => index > 0), String(order));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  // Unfiled cards are a virtualized list, and each card names its place.
  assert.match(html, /data-research-card="older"[^>]*data-research-place="system:unfiled"[^>]*data-research-card-virtual=""/);
  assert.doesNotMatch(html, /Load older activity/);
});

test("the agent setup guide appears only when the Home feed is empty", () => {
  const setupGuide = createElement("div", null, "Agent setup guide");

  const emptyWithGuide = renderFeed({ setupGuide });
  assert.match(emptyWithGuide, /Agent setup guide/);
  assert.doesNotMatch(emptyWithGuide, /appear here\. New ones start at the top/);
  assert.match(renderFeed({}), /Research, notes, and saved links appear here\. New ones start at the top\./);
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

test("Enter on a feed row only selects it; → also moves into the opened thread", () => {
  const key = (name: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    feedRowOpenKey({ key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });
  assert.equal(key("Enter"), "select");
  assert.equal(key("ArrowRight"), "enter-thread");
  assert.equal(key("ArrowDown"), null);
  assert.equal(key(" "), null);
  // ⌥→ is Forward; modified Enter is not a row key.
  assert.equal(key("ArrowRight", { altKey: true }), null);
  assert.equal(key("Enter", { metaKey: true }), null);
  assert.equal(key("Enter", { shiftKey: true }), null);
});

test("Home offers report import", () => {
  const html = renderFeed({ onImportReport: asyncNoop, items: [{
    nodeId: "import", treeId: "import-tree", inline: false, prompt: "Original prompt",
    adapter: "codex", model: null, type: "document", source: "imported", status: "complete", createdAt: 100,
  }] });
  assert.match(html, /aria-label="Import \.md report"/);
  assert.ok(html.indexOf('aria-label="Refresh Home"') < html.indexOf('aria-label="Import .md report"'));
  assert.match(html, /accept=".md,text\/markdown"/);
  assert.doesNotMatch(renderFeed({ view: { kind: "drafts" }, onImportReport: asyncNoop }), /Import \.md report/);
});

test("a network post is an untitled card showing its body", () => {
  const html = renderFeed({ items: [{
    nodeId: "post", treeId: "post-tree", parentNodeId: null, inline: false,
    prompt: "Who ships component-model plugins?", adapter: "claude", model: "fable",
    type: "post" as const, status: "complete" as const, createdAt: 100,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{ id: "r1", author: { kind: "member", id: "ana", displayName: "Ana Moreau", handle: "ana" }, body: "We moved in March.", createdAt: 110 }],
    },
    replyCount: 7,
  }] });
  assert.match(html, /Who ships component-model plugins\?/);
  assert.doesNotMatch(html, /research-feed-card-title/);
  // Replies open with the post; the card shows only the question.
  assert.doesNotMatch(html, /We moved in March\.|7 replies/);
});

test("Archive has no ask box; Home keeps it", () => {
  assert.doesNotMatch(renderFeed({ view: { kind: "archive" } }), /Query composer/);
  assert.match(renderFeed({}), /Query composer/);
});
