import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchBranchesColumn,
  type ResearchBranchSourceProps,
  type ResearchChainRowsShared,
} from "../src/components/research/ResearchMessagesColumn";
import { researchBranchesByParent } from "../src/lib/researchBranchView";
import { researchStrip, type ResearchBranchesColumn as BranchesColumn } from "../src/lib/researchColumns";
import { researchNodeLabel } from "../src/lib/researchThreadView";
import type { ResearchHighlightAnchor, ResearchNode } from "../src/types";
import { researchNode } from "./researchNodeFixture";

const noop = () => {};

const anchor = (exact: string, start: number) =>
  ({
    version: 1,
    projection: "answer-v1",
    responseRevision: "rev",
    start,
    end: start + exact.length,
    exact,
    prefix: "",
    suffix: "",
  }) as ResearchHighlightAnchor;

const node = (id: string, fields: Parameters<typeof researchNode>[0] = {}) =>
  researchNode({
    id,
    treeId: "tree",
    prompt: id,
    adapter: "claude",
    groupId: "ws",
    status: "complete",
    sessionReady: true,
    createdAt: 0,
    highlights: [],
    ...fields,
  });

// A document, an AI answer after it, a passage branch of each, and a
// follow-up in the answer's branch.
const nodes: ResearchNode[] = [
  node("doc", { type: "document", title: "Survey of compute thresholds", createdAt: 0 }),
  node("ans", { parentNodeId: "doc", inline: true, prompt: "What do these thresholds leave out?", createdAt: 1 }),
  node("d1", {
    parentNodeId: "doc",
    anchor: { kind: "passage", anchor: anchor("Most proposals", 4) },
    prompt: "Which proposals use 10^26?",
    createdAt: 2,
  }),
  node("a1", {
    parentNodeId: "ans",
    anchor: { kind: "passage", anchor: anchor("training compute", 2) },
    prompt: "How is training compute estimated?",
    createdAt: 3,
  }),
  node("a1f", { parentNodeId: "a1", inline: true, prompt: "Who runs them?", createdAt: 4 }),
];
const nodeById = new Map(nodes.map((candidate) => [candidate.id, candidate]));

function render(selected: string, pending: { parentNodeId: string; anchor: ResearchHighlightAnchor | null } | null = null) {
  const strip = researchStrip(nodes, selected, pending);
  const column = strip.columns.find((candidate): candidate is BranchesColumn => candidate.role === "branches");
  assert.ok(column);
  const shared: ResearchChainRowsShared = {
    archived: false,
    treeTitle: "Survey",
    nodeById,
    branchesByParent: researchBranchesByParent(nodes),
    queuedRetries: new Set(),
    answerMenuOpenId: null,
    isUnread: () => false,
    rowActions: {
      registerSegmentElement: noop,
      onSelect: noop,
      onShowBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
      onDragStart: noop,
    },
  };
  const sourceOf = (group: BranchesColumn["groups"][number]): ResearchBranchSourceProps => {
    const parentId = group.kind === "branch" ? group.sourceId : group.parentNodeId;
    return {
      anchor: group.anchor,
      parent: nodeById.get(parentId),
      created: group.kind === "branch",
      resolves: true,
      parentLoaded: true,
      from: researchNodeLabel(nodeById.get(parentId), "Survey"),
    };
  };
  const html = renderToStaticMarkup(
    createElement(ResearchBranchesColumn, {
      column,
      current: true,
      shared,
      branchOpen: false,
      sourceOf,
      menuOf: () => ({ label: "Branch actions", open: false, onOpen: noop }),
      composerOf: (group) =>
        createElement("div", { className: "test-composer" }, group.kind === "branch" ? `ask ${group.headId}` : "ask new"),
      queueOf: () => ({ items: [], tailStalled: false, onRemove: noop, onRetry: noop, onEdit: noop }),
      onScroll: undefined,
    }),
  );
  return { html, column };
}

const groupsOf = (html: string) => [...html.matchAll(/data-research-branch-group="([^"]+)"/g)].map((match) => match[1]);

test("the branches column stacks the document's and the answer's branches, each with its source, messages and ask box", () => {
  const { html, column } = render("ans");
  assert.equal(column.id, "T1");
  assert.match(html, /^<section class="research-pair-messages is-branches is-closed is-current" data-research-column="T1" data-research-pair="messages" data-research-level="1" aria-label="Branches">/);
  assert.match(html, /Branches<span class="research-column-count"> · 2<\/span>/);
  // Reading order: the document's branch, then the answer's.
  assert.deepEqual(groupsOf(html), ["d1", "a1"]);
  // Each group names the message it was asked from and quotes the passage.
  assert.match(html, /research-branch-source-from" title="Survey of compute thresholds">Survey of compute thresholds</);
  assert.match(html, /research-branch-source-from" title="What do these thresholds leave out\?">/);
  assert.match(html, /<i>“Most proposals”<\/i>/);
  assert.match(html, /<i>“training compute”<\/i>/);
  // One ask box per group, after its messages.
  assert.deepEqual([...html.matchAll(/class="test-composer">([^<]+)</g)].map((match) => match[1]), ["ask d1", "ask a1"]);
  assert.ok(html.indexOf('data-node-id="a1f"') < html.indexOf("ask a1"));
  // Every group has a … menu.
  assert.equal([...html.matchAll(/aria-label="Branch actions"/g)].length, 2);
  // No branch is open: nothing is selected, and the first row is in the tab order.
  assert.doesNotMatch(html, /is-selected/);
  assert.match(html, /data-node-id="d1" aria-labelledby="[^"]+" tabindex="0"/);
  assert.match(html, /data-node-id="a1" aria-labelledby="[^"]+" tabindex="-1"/);
});

test("the open branch's group holds the column's selected row", () => {
  const { html, column } = render("a1f");
  assert.equal(column.level?.headId, "a1");
  assert.match(html, /class="research-pair-messages is-branches is-current"/);
  assert.match(html, /class="research-branch-group is-open" data-research-branch-group="a1"/);
  assert.match(html, /is-selected[^]*data-node-id="a1f" aria-current="true"/);
  assert.match(html, /data-node-id="d1" aria-labelledby="[^"]+" tabindex="-1"/);
});

test("an unsent branch is a group at its source's position, with its first question's ask box", () => {
  const { html } = render("doc", { parentNodeId: "doc", anchor: anchor("thresholds", 30) });
  assert.deepEqual(groupsOf(html), ["d1", "pending:doc", "a1"]);
  assert.match(html, /class="research-branch-group is-pending" data-research-branch-group="pending:doc" aria-label="New branch"/);
  assert.match(html, /<i>“thresholds”<\/i>/);
  assert.deepEqual([...html.matchAll(/class="test-composer">([^<]+)</g)].map((match) => match[1]), ["ask d1", "ask new", "ask a1"]);
});
