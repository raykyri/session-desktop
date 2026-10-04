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

test("the Archived page renders one card per archived thread", () => {
  const html = renderArchived({
    trees: [
      tree("run"),
      tree("conversation", { kind: "conversation", title: "Terminal session", archivedAt: 200 }),
    ],
    selectedTreeId: "run",
  });
  assert.match(html, /Archived/);
  assert.equal((html.match(/class="research-feed-post(?=[ "])/g) ?? []).length, 2);
  assert.equal((html.match(/research-feed-post is-selected/g) ?? []).length, 1);
  assert.ok(html.indexOf("Terminal session") < html.indexOf("Thread run"));
  assert.match(html, /lucide-terminal/);
  // Archived cards carry no Follow or Bookmark controls.
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("the Archived page explains itself when empty", () => {
  assert.match(renderArchived(), /Archived research appears here/);
});
