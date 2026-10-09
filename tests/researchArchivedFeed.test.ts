import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchArchivedFeed, {
  archivedFeedTrees,
  type ResearchArchivedFeedProps,
} from "../src/components/research/ResearchArchivedFeed";
import type { ResearchTreeSummary } from "../src/types";

const asyncNoop = async () => {};

function tree(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id,
    title: `Thread ${id}`,
    rootNodeId: `${id}-root`,
    kind: "run",
    workspaceId: "workspace",
    runningCount: 0,
    failedCount: 0,
    completedCount: 1,
    cancelledCount: 0,
    updatedAt: 1,
    archivedAt: 100,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
    ...overrides,
  };
}

function renderArchived(overrides: Partial<ResearchArchivedFeedProps> = {}) {
  return renderToStaticMarkup(
    createElement(ResearchArchivedFeed, {
      trees: [],
      onOpen: () => {},
      onRestore: asyncNoop,
      onRemove: asyncNoop,
      ...overrides,
    }),
  );
}

test("archived threads list newest-archived first, without active trees or documents", () => {
  const ordered = archivedFeedTrees([
    tree("older", { archivedAt: 100 }),
    tree("active", { archivedAt: null }),
    tree("document", { kind: "document", archivedAt: 300 }),
    tree("newer", { archivedAt: 200 }),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["newer", "older"],
  );
});

test("Archive renders one card per archived thread, newest archived first", () => {
  const html = renderArchived({
    trees: [
      tree("run"),
      tree("conversation", { kind: "conversation", title: "Terminal session", archivedAt: 200 }),
    ],
    selectedTreeId: "run",
    onMenu: () => {},
  });
  assert.equal((html.match(/class="research-feed-card(?=[ "])/g) ?? []).length, 2);
  assert.equal((html.match(/research-feed-card is-selected/g) ?? []).length, 1);
  assert.ok(html.indexOf("Terminal session") < html.indexOf("Thread run"));
  // Archived cards are drop sources for moving out of Archive, and carry the
  // … menu but no Follow or Bookmark controls.
  assert.match(html, /data-research-card="run"/);
  assert.match(html, /aria-label="Bookmark or move"/);
  // The archive time is in the card's tooltip.
  assert.match(html, /aria-label="Thread run"[^>]*title="Archived [^"]+"/);
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("Archive explains itself when empty", () => {
  assert.match(
    renderArchived(),
    /Archive is empty\. Archived questions stop sending follow-up notifications\./,
  );
});
