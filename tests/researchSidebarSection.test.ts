import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchSidebarSection from "../src/components/research/ResearchSidebarSection";
import type { ResearchTreeSummary } from "../src/types";

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
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
    ...overrides,
  };
}

const asyncNoop = async () => {};

test("the research sidebar lists trees as a flat list without folder or star controls", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSidebarSection, {
      trees: [tree("a"), tree("b", { hasUnseenFailure: true })],
      activeTreeId: "a",
      onSelect: () => {},
      onRename: asyncNoop,
      onArchive: asyncNoop,
      onRemove: asyncNoop,
      onReorder: () => {},
    }),
  );
  assert.equal(html.match(/data-research-tree-id=/g)?.length, 2);
  assert.match(html, /class="research-sidebar-row is-selected" data-research-tree-id="a"/);
  assert.match(html, /research-sidebar-failed/);
  assert.doesNotMatch(html, /folder/i);
  assert.doesNotMatch(html, /star/i);
  assert.doesNotMatch(html, /⌘\d/);
});
