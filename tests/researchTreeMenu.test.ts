import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchTreeMenuItems } from "../src/components/research/ResearchTreeMenu";
import ResearchFolderDialog from "../src/components/research/ResearchFolderDialog";
import { emptyResearchFolderState } from "../src/lib/researchFolders";
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
        folderState: emptyResearchFolderState(),
        onClose: noop,
        onToggleStar: noop,
        onRename: noop,
        onArchive: noop,
        onRestore: noop,
        onDelete: noop,
        onRemoveFromFolder: noop,
        onRequestCreateFolder: noop,
      }),
    );
    assert.match(html, /Star/);
    assert.match(html, /Rename/);
    assert.match(html, /New folder with item/);
    assert.match(html, /Archive/);
    assert.match(html, /Delete/);
    assert.doesNotMatch(html, /Regenerate title/);
  }
});

test("the new-folder dialog names a single selected item", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchFolderDialog, {
      open: true,
      itemCount: 1,
      onClose: noop,
      onCreate: noop,
    }),
  );
  assert.match(html, /Create a folder with 1 item:/);
  assert.match(html, />Create</);
  assert.doesNotMatch(html, /Name the folder before moving/);
  assert.doesNotMatch(html, /Create and move/);
});
