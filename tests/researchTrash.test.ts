import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchDeleteDialogPanel } from "../src/components/research/ResearchDeleteDialog";
import { ResearchSidebarNav, ResearchSidebarRail } from "../src/components/research/ResearchSidebarNav";
import { researchBranchDeleteDialogProps } from "../src/components/research/ResearchThreadDialogs";
import { researchTreeDeleteDialogProps } from "../src/components/research/ResearchTreeMenu";
import {
  researchTrashCount,
  researchTrashEntries,
  researchTrashFolderSentence,
  researchTrashTreeSentence,
} from "@session/shared/lib/researchTrash";
import type { ResearchTreeSummary } from "../src/types";
import { researchNode } from "./researchNodeFixture";

const noop = () => {};
const asyncNoop = async () => {};

function summary(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id, title: `Title ${id}`, rootNodeId: `${id}-root`, type: "exchange", workspaceId: "ws",
    runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 1,
    archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false, ...overrides,
  };
}

test("the Trash lists one workspace's trees and folders, most recently trashed first", () => {
  const entries = researchTrashEntries(
    [
      summary("a", { trashedAt: 10 }),
      summary("b", { trashedAt: 30 }),
      summary("other", { trashedAt: 50, workspaceId: "ws-2" }),
      summary("listed"),
    ],
    [
      { id: "f1", name: "Folder", workspaceId: "ws", trashedAt: 20 },
      { id: "f2", name: "Live folder", workspaceId: "ws" },
    ],
    "ws",
  );
  assert.deepEqual(
    entries.map((entry) => `${entry.kind}:${entry.id}`),
    ["tree:b", "folder:f1", "tree:a"],
  );
  assert.equal(entries[1].title, "Folder");
  assert.deepEqual(researchTrashEntries([summary("a", { trashedAt: 1 })], [], null), []);
  assert.equal(researchTrashCount(1), "1 item");
  assert.equal(researchTrashCount(3), "3 items");
});

test("the delete sentences say what moves to the Trash", () => {
  assert.equal(researchTrashTreeSentence(null), "It moves to the Trash, where you can restore it.");
  assert.equal(
    researchTrashTreeSentence(2),
    "It moves to the Trash with its 2 follow-ups, where you can restore it.",
  );
  assert.equal(
    researchTrashFolderSentence(3),
    "The folder moves to the Trash. Its 3 questions show in Unfiled until you restore it.",
  );
});

function render(props: Parameters<typeof ResearchDeleteDialogPanel>[0]) {
  return renderToStaticMarkup(createElement(ResearchDeleteDialogPanel, props));
}

test("a thread's delete confirmation defaults to Move to Trash with Delete now before Cancel and Move to Trash", () => {
  const props = researchTreeDeleteDialogProps({
    tree: summary("t", { title: "Memory" }),
    onClose: noop,
    onTrash: asyncNoop,
    onRemove: asyncNoop,
  });
  const html = render(props);
  assert.match(html, /<h2 id="[^"]+">Delete “Memory”\?<\/h2>/);
  assert.match(html, /It moves to the Trash, where you can restore it\./);
  const actions = html.slice(html.indexOf('class="confirm-dialog-actions"'));
  assert.match(
    actions,
    /^class="confirm-dialog-actions"><button type="button" class="confirm-dialog-link">Delete now<\/button><button class="control-button" type="button">Cancel<\/button><button type="button" class="control-button primary" autofocus="">Move to Trash<\/button><\/div>/,
  );

  // Delete now replaces the content with the permanent confirmation.
  const now = render({ ...props, initialStep: "remove" });
  assert.match(now, /<h2 id="[^"]+">Delete permanently\?<\/h2>/);
  assert.match(now, /<p>This can’t be undone\.<\/p>/);
  assert.doesNotMatch(now, /Delete now|Move to Trash/);
  assert.match(
    now,
    /<button class="control-button" type="button">Cancel<\/button><button type="button" class="control-button danger" autofocus="">Delete<\/button>/,
  );

  // Active runs block both actions and say why.
  const running = render(
    researchTreeDeleteDialogProps({
      tree: summary("t", { runningCount: 1 }),
      onClose: noop,
      onTrash: asyncNoop,
      onRemove: asyncNoop,
    }),
  );
  assert.match(running, /<p role="status">It has active runs/);
  assert.match(running, /class="control-button primary" disabled="">Move to Trash/);
});

test("deleting the root moves the thread to the Trash; deleting a branch or note inside it is permanent", () => {
  const root = researchNode({ id: "root", treeId: "t", prompt: "Root question", title: null });
  const rootHtml = render(
    researchBranchDeleteDialogProps({
      node: root,
      info: { descendantCount: 2, hasActiveRuns: false },
      isRoot: true,
      treeTitle: "Tree",
      onTrashRoot: asyncNoop,
      onRemove: asyncNoop,
      onClose: noop,
    }),
  );
  assert.match(rootHtml, /Delete “Root question”\?/);
  assert.match(rootHtml, /It moves to the Trash with its 2 follow-ups, where you can restore it\./);
  assert.match(rootHtml, />Delete now</);

  const child = researchNode({
    id: "child", treeId: "t", parentNodeId: "root", prompt: "Follow-up question", title: null,
  });
  const childHtml = render(
    researchBranchDeleteDialogProps({
      node: child,
      info: { descendantCount: 1, hasActiveRuns: false },
      isRoot: false,
      treeTitle: "Tree",
      onTrashRoot: asyncNoop,
      onRemove: asyncNoop,
      onClose: noop,
    }),
  );
  assert.match(childHtml, /Delete this research branch\?/);
  assert.match(childHtml, /This also deletes 1 follow-up under it\. This can’t be undone\./);
  assert.doesNotMatch(childHtml, /Delete now|Move to Trash/);
  assert.match(childHtml, /class="control-button danger" autofocus="">Delete branch</);

  const note = researchNode({
    id: "note", treeId: "t", parentNodeId: "root", type: "post", prompt: "A note", title: null,
  });
  const noteHtml = render(
    researchBranchDeleteDialogProps({
      node: note,
      info: { descendantCount: 0, hasActiveRuns: false },
      isRoot: false,
      treeTitle: "Tree",
      onTrashRoot: asyncNoop,
      onRemove: asyncNoop,
      onClose: noop,
    }),
  );
  assert.match(noteHtml, /Delete this note\?/);
  assert.match(noteHtml, /This deletes the note\. This can’t be undone\./);
  assert.match(noteHtml, />Delete note</);
});

test("the sidebar and its icon rail list Trash right after Archive, without a drop target", () => {
  const folders = [{ id: "f1", name: "Reading", workspaceId: "ws" }];
  const nav = renderToStaticMarkup(
    createElement(ResearchSidebarNav, {
      current: { kind: "trash" },
      folders,
      onNavigate: noop,
      onNewFolder: noop,
      onRenameFolder: noop,
      onDeleteFolder: noop,
    }),
  );
  const labels = [...nav.matchAll(/research-nav-label">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Home", "Highlights", "Drafts", "Reading", "Archive", "Trash"]);
  assert.match(nav, /research-nav-row is-selected"><button type="button" class="research-nav-select" aria-current="page">/);
  const trashRow = nav.slice(nav.lastIndexOf('<div class="research-nav-row'));
  assert.doesNotMatch(trashRow, /data-research-drop/);

  const rail = renderToStaticMarkup(
    createElement(ResearchSidebarRail, {
      current: null,
      folders,
      forced: false,
      reserveTitlebar: false,
      expandShortcut: "⌘B",
      onExpand: noop,
      onNavigate: noop,
      onNewFolder: noop,
      footer: null,
    }),
  );
  const icons = [...rail.matchAll(/class="research-rail-icon[^"]*" aria-label="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(icons.slice(-4), ["Reading", "Archive", "Trash", "New folder"]);
});
