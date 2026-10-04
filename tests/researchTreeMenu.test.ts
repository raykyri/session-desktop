import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchTreeMenuItems } from "../src/components/research/ResearchTreeMenu";
import type { ResearchTreeSummary } from "../src/types";

const tree: ResearchTreeSummary = {
  id: "tree-1",
  title: "Collective memory",
  rootNodeId: "root",
  kind: "conversation",
  workspaceId: "workspace",
  runningCount: 0,
  failedCount: 0,
  completedCount: 2,
  cancelledCount: 0,
  updatedAt: 200,
  hasUnseenUpdate: false,
  hasUnseenFailure: false,
};

const noop = () => {};

test("research tree menus omit regenerate title for every kind", () => {
  for (const kind of ["conversation", "run", "document"] as const) {
    const html = renderToStaticMarkup(
      createElement(ResearchTreeMenuItems, {
        tree: { ...tree, kind },
        archived: false,
        onClose: noop,
        onRename: noop,
        onArchive: noop,
        onRestore: noop,
        onDelete: noop,
      }),
    );
    assert.match(html, /Rename/);
    assert.doesNotMatch(html, /Star/);
    assert.doesNotMatch(html, /folder/i);
    assert.match(html, /Archive/);
    assert.match(html, /Delete/);
    assert.doesNotMatch(html, /Regenerate title/);
  }
});

test("research tree menus can expose query summary regeneration", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTreeMenuItems, {
      tree,
      archived: false,
      onClose: noop,
      onRename: noop,
      onArchive: noop,
      onRestore: noop,
      onDelete: noop,
      onRegenerateSummary: noop,
    }),
  );
  assert.match(html, /Generate summary/);
});
