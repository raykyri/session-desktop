import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchFeedRowMenuItems } from "../src/components/research/ResearchMoveMenu";
import { ResearchTreeLifecycleItems } from "../src/components/research/ResearchTreeMenu";
import type { ResearchTreeSummary } from "../src/types";

const tree: ResearchTreeSummary = {
  id: "tree-1",
  title: "Collective memory",
  rootNodeId: "root",
  type: "document",
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

test("research tree menus omit regenerate title for every node type", () => {
  for (const type of ["post", "exchange", "document"] as const) {
    const html = renderToStaticMarkup(
      createElement(ResearchTreeLifecycleItems, {
        tree: { ...tree, type },
        archived: false,
        onClose: noop,
        onRename: noop,
        onRestore: noop,
        onDelete: noop,
      }),
    );
    assert.match(html, /Rename/);
    assert.doesNotMatch(html, /Star/);
    assert.doesNotMatch(html, /folder/i);
    // Archiving is the Archive entry under Move to.
    assert.doesNotMatch(html, />Archive</);
    assert.match(html, /Delete/);
    assert.doesNotMatch(html, /Regenerate title/);
  }
});

test("research tree menus can expose recap regeneration", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTreeLifecycleItems, {
      tree,
      archived: false,
      onClose: noop,
      onRename: noop,
      onRestore: noop,
      onDelete: noop,
      onRegenerateRecap: noop,
    }),
  );
  assert.match(html, /Generate recap/);
});

test("archived cards' thread actions are Unarchive and Delete only", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTreeLifecycleItems, {
      tree: { ...tree, archivedAt: 300 },
      archived: true,
      onClose: noop,
      onRestore: noop,
      onDelete: noop,
    }),
  );
  assert.match(html, /Unarchive research/);
  assert.match(html, /Delete/);
  assert.doesNotMatch(html, /Rename/);
  assert.doesNotMatch(html, />Archive</);
});

test("Delete carries its D shortcut, disabled with a reason while running", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTreeLifecycleItems, {
      tree: { ...tree, runningCount: 1 },
      archived: false,
      onClose: noop,
      onRename: noop,
      onDelete: noop,
    }),
  );
  assert.doesNotMatch(html, /data-shortcut="a"/);
  assert.match(html, /disabled="" title="Research with active runs cannot be deleted" data-shortcut="d"/);
  assert.equal(html.match(/role="separator"/g)?.length, 1);
});

/** The menu's items in order, with "|" for a separator and a "Move to"
 * heading. */
function menuOutline(html: string): string[] {
  return [
    ...html.matchAll(
      /role="separator"|class="research-menu-title"[^>]*>([^<]+)<|<button[^>]*role="menuitem(?:radio)?"[^>]*>[^]*?<span class="research-menu-label">([^<]+)</g,
    ),
  ].map((match) => (match[0] === 'role="separator"' ? "|" : (match[1] ?? match[2])));
}

const folders = [{ id: "f-read", name: "Reading list", workspaceId: "workspace" }];

function feedCardMenu(
  overrides: { archived?: boolean; recap?: boolean; archiveShortcut?: boolean } = {},
) {
  const archived = overrides.archived ?? false;
  return renderToStaticMarkup(
    createElement(
      ResearchFeedRowMenuItems,
      {
        currentPlace: archived ? "system:archive" : "system:unfiled",
        folders,
        archiveShortcut: overrides.archiveShortcut ?? true,
        onToggleBookmark: noop,
        onMove: noop,
        onNewFolder: noop,
      },
      createElement(ResearchTreeLifecycleItems, {
        tree: archived ? { ...tree, archivedAt: 300 } : tree,
        archived,
        onClose: noop,
        onRename: noop,
        onRestore: noop,
        onDelete: noop,
        onRegenerateRecap: overrides.recap === false || archived ? undefined : noop,
      }),
    ),
  );
}

test("a feed card's one menu lists the question's actions, then the thread's, Delete last; Archive is under Move to", () => {
  assert.deepEqual(menuOutline(feedCardMenu()), [
    "Bookmark",
    "|",
    "Move to",
    "Unfiled",
    "Drafts",
    "Reading list",
    "Archive",
    "|",
    "New folder…",
    "|",
    "Generate recap",
    "Rename",
    "|",
    "Delete",
  ]);
  // Without a recap, Rename alone precedes the separator.
  assert.deepEqual(menuOutline(feedCardMenu({ recap: false })).slice(9), [
    "|",
    "Rename",
    "|",
    "Delete",
  ]);
  const html = feedCardMenu();
  assert.match(html, /class="research-menu-item is-danger"[^>]*data-shortcut="d"/);
  // Archive appears once under Move to and exposes the Home menu's A shortcut.
  assert.equal(html.match(/>Archive</g)?.length, 1);
  assert.match(html, /aria-keyshortcuts="A"[^>]*data-shortcut="a"[^>]*>[^]*?Archive[^]*?<kbd[^>]*>A<\/kbd>/);
});

test("the Archive shortcut is limited to available Archive targets in Home", () => {
  assert.doesNotMatch(feedCardMenu({ archiveShortcut: false }), /data-shortcut="a"/);
  assert.doesNotMatch(feedCardMenu({ archived: true }), /data-shortcut="a"/);
});

test("an archived card's menu ends with Unarchive and Delete", () => {
  const html = feedCardMenu({ archived: true });
  assert.deepEqual(menuOutline(html), [
    "Bookmark",
    "|",
    "Move to",
    "Unfiled",
    "Drafts",
    "Reading list",
    "Archive",
    "|",
    "New folder…",
    "|",
    "Unarchive research",
    "Delete",
  ]);
});

test("a starred child row's menu has Remove star and the question's actions, no thread actions", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchFeedRowMenuItems, {
      currentPlace: "system:unfiled",
      folders,
      onRemoveStar: noop,
      onToggleBookmark: noop,
      onMove: noop,
      onNewFolder: noop,
    }),
  );
  assert.deepEqual(menuOutline(html), [
    "Remove star",
    "|",
    "Bookmark",
    "|",
    "Move to",
    "Unfiled",
    "Drafts",
    "Reading list",
    "Archive",
    "|",
    "New folder…",
  ]);
});
