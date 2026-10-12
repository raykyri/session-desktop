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
  node("aw", { parentNodeId: "ans", prompt: "Summarise the answer.", createdAt: 5 }),
];
const nodeById = new Map(nodes.map((candidate) => [candidate.id, candidate]));

function render(
  selected: string | string[],
  pending: { parentNodeId: string; anchor: ResearchHighlightAnchor | null } | null = null,
  branchStateOf: ResearchChainRowsShared["branchStateOf"] = () => null,
) {
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
    branchStateOf,
    rowActions: {
      registerSegmentElement: noop,
      onSelect: noop,
      onToggleBranches: noop,
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
      openSourceId: strip.levels[2]?.sourceId ?? null,
      sourceOf,
      composerOf: (group) =>
        createElement("div", { className: "test-composer" }, group.kind === "branch" ? `ask ${group.headId}` : "ask new"),
      queueOf: () => ({ items: [], tailStalled: false, onRemove: noop, onRetry: noop, onEdit: noop }),
      onClear: noop,
      onScroll: undefined,
    }),
  );
  return { html, column };
}

const groupsOf = (html: string) => [...html.matchAll(/data-research-branch-group="([^"]+)"/g)].map((match) => match[1]);

test("the branches column stacks the document's and the answer's branches, each with its source and messages", () => {
  const { html, column } = render("ans");
  assert.equal(column.id, "T1");
  assert.match(html, /^<section class="research-pair-messages is-branches is-closed is-current" data-research-column="T1" data-research-pair="messages" data-research-level="1" aria-label="Branches">/);
  // The header: the branch icon, "Branches · N", and no × with nothing selected.
  assert.match(html, /<svg class="research-column-title-icon"[^]*<\/svg>Branches<span class="research-column-count"> · 3<\/span>/);
  assert.doesNotMatch(html, /research-head-clear/);
  // Reading order: the document's branch, then the answer's passage branch,
  // then its whole-answer branch.
  assert.deepEqual(groupsOf(html), ["d1", "a1", "aw"]);
  // Each group names the message it was asked from and quotes the passage.
  assert.match(html, /research-branch-source-from" title="Survey of compute thresholds">Survey of compute thresholds</);
  assert.match(html, /research-branch-source-from" title="What do these thresholds leave out\?">/);
  assert.match(html, /<i>“Most proposals”<\/i>/);
  assert.match(html, /<i>“training compute”<\/i>/);
  // A whole-answer group's source is the message alone, with the same glyph.
  const whole = html.slice(html.indexOf('data-research-branch-group="aw"'));
  assert.match(whole, /lucide-corner-down-right[^]*research-branch-source-from[^>]*>What do these thresholds leave out\?<\/span><span class="research-branch-source-quote"><\/span>/);
  assert.doesNotMatch(html, /The whole answer/);
  // No group holds a selection: no ask box, and no … menu in the groups.
  assert.doesNotMatch(html, /test-composer/);
  assert.doesNotMatch(html, /aria-label="Branch actions"/);
  // Nothing is selected, and the first row is in the tab order.
  assert.doesNotMatch(html, /is-selected/);
  assert.match(html, /data-node-id="d1" aria-labelledby="[^"]+" tabindex="0"/);
  assert.match(html, /data-node-id="a1" aria-labelledby="[^"]+" tabindex="-1"/);
});

test("only the group that holds the column's selection has the ask box, after its messages", () => {
  const { html, column } = render("a1f");
  assert.equal(column.level?.headId, "a1");
  assert.match(html, /class="research-pair-messages is-branches is-current"/);
  assert.match(html, /class="research-branch-group is-open" data-research-branch-group="a1"/);
  assert.match(html, /is-selected[^]*data-node-id="a1f" aria-current="true"/);
  assert.match(html, /data-node-id="d1" aria-labelledby="[^"]+" tabindex="-1"/);
  assert.deepEqual([...html.matchAll(/class="test-composer">([^<]+)</g)].map((match) => match[1]), ["ask a1"]);
  assert.ok(html.indexOf('data-node-id="a1f"') < html.indexOf("ask a1"));
  // The header's × clears the column's selection.
  assert.match(html, /class="control-button research-head-button research-head-clear" aria-label="Clear the selection in this column"/);
});

test("a row with branches shows an indicator: accent when one is selected in the next column, the running glyph while one runs", () => {
  const branched = [
    ...nodes,
    node("a1fb", { parentNodeId: "a1f", prompt: "Deeper", createdAt: 6 }),
    node("d1b", { parentNodeId: "d1", prompt: "Also deeper", createdAt: 7 }),
  ];
  const strip = researchStrip(branched, ["ans", "a1f", "a1fb"], null);
  // The next branches column lists the branches of every group's messages.
  const next = strip.columns.find((candidate) => candidate.id === "T2");
  assert.equal(next?.role, "branches");
  if (next?.role === "branches") {
    assert.deepEqual(next.groups.map((group) => (group.kind === "branch" ? group.headId : "")), ["d1b", "a1fb"]);
  }
  const column = strip.columns.find((candidate): candidate is BranchesColumn => candidate.id === "T1");
  assert.ok(column);
  const branchedById = new Map(branched.map((candidate) => [candidate.id, candidate]));
  const html = renderToStaticMarkup(
    createElement(ResearchBranchesColumn, {
      column,
      current: true,
      shared: {
        archived: false,
        treeTitle: "Survey",
        nodeById: branchedById,
        branchesByParent: researchBranchesByParent(branched),
        queuedRetries: new Set<string>(),
        answerMenuOpenId: null,
        isUnread: () => false,
        branchStateOf: (id) => (id === "d1" ? "running" : null),
        rowActions: {
          registerSegmentElement: noop,
          onSelect: noop,
          onToggleBranches: noop,
          onOpenAnswerMenu: noop,
          onOpenContextMenu: noop,
          onDragStart: noop,
        },
      },
      openSourceId: strip.levels[2]?.sourceId ?? null,
      sourceOf: (group) => ({
        anchor: group.anchor,
        parent: branchedById.get(group.kind === "branch" ? group.sourceId : group.parentNodeId),
        created: true,
        resolves: true,
        parentLoaded: true,
        from: "Survey",
      }),
      composerOf: () => null,
      queueOf: () => ({ items: [], tailStalled: false, onRemove: noop, onRetry: noop, onEdit: noop }),
      onClear: noop,
      onScroll: undefined,
    }),
  );
  const indicator = (id: string) =>
    new RegExp(`class="control-button research-msg-button research-msg-branches([^"]*)"[^>]*data-research-branch-trigger="${id}"`).exec(html)?.[1];
  assert.equal(indicator("a1f"), " is-open");
  assert.equal(indicator("d1"), " is-running");
  assert.match(html, /data-research-branch-trigger="d1"[^>]*>(?:(?!<\/button>).)*research-row-glyph is-running/);
  assert.match(html, /data-research-branch-trigger="a1f"[^>]*>(?:(?!<\/button>).)*lucide-arrow-up-right/);
});

test("an unsent branch is a group at its source's position, with its first question's ask box", () => {
  const { html } = render("doc", { parentNodeId: "doc", anchor: anchor("thresholds", 30) });
  assert.deepEqual(groupsOf(html), ["d1", "pending:doc", "a1", "aw"]);
  assert.match(html, /class="research-branch-group is-pending" data-research-branch-group="pending:doc" aria-label="New branch"/);
  assert.match(html, /<i>“thresholds”<\/i>/);
  assert.deepEqual([...html.matchAll(/class="test-composer">([^<]+)</g)].map((match) => match[1]), ["ask new"]);
});
