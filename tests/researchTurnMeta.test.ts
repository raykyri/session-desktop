import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchMessageRow,
  researchMessagePill,
  runStatusText,
} from "../src/components/research/ResearchTurn";
import type { ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const noop = () => {};

function node(overrides: NodeFixture = {}): ResearchNode {
  return researchNode({
    id: "n1",
    treeId: "tree",
    prompt: "A question",
    adapter: "claude",
    groupId: "ws",
    status: "complete",
    sessionReady: true,
    createdAt: 0,
    highlights: [],
    ...overrides,
  });
}

const row = (overrides: NodeFixture = {}, retryQueued = false) =>
  renderToStaticMarkup(
    createElement(ResearchMessageRow, {
      node: node(overrides),
      level: 1,
      label: "A question",
      showPrompt: true,
      selected: true,
      starrable: true,
      retryQueued,
      branchCount: 2,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: false,
      registerSegmentElement: noop,
      onSelect: noop,
      onShowBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
    }),
  );

test("the answer's … menu button sits in the row's corner pill, after the meta line", () => {
  const html = row();
  const meta = html.indexOf('class="research-msg-meta"');
  const branch = html.indexOf('aria-label="2 branches from this answer"');
  const rail = html.indexOf('class="research-feed-rail"');
  assert.ok(meta >= 0 && branch > meta && rail > branch);
  const pill = html.slice(rail);
  assert.match(
    pill,
    /^class="research-feed-rail"><button type="button" class="research-feed-icon-button research-feed-card-menu" title="Answer details and actions" aria-label="Answer actions" aria-haspopup="menu" aria-expanded="false" tabindex="0"/,
  );
  // The star is an item of that menu, not a button in the row.
  assert.doesNotMatch(html, /aria-label="Star"|aria-pressed/);
});

test("a row whose menu is open keeps its pill shown", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchMessageRow, {
      node: node(),
      level: 0,
      label: "A question",
      showPrompt: true,
      selected: false,
      starrable: false,
      branchCount: 0,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: true,
      registerSegmentElement: noop,
      onSelect: noop,
      onShowBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
      dragPlace: "chain:n1",
      onDragStart: noop,
    }),
  );
  assert.match(html, /class="research-msg-row is-status-complete has-open-menu"/);
  assert.match(
    html,
    /class="research-feed-rail"><span class="research-feed-card-grip" aria-hidden="true">[^]*aria-expanded="true" tabindex="-1"/,
  );
});

test("the answer menu is hidden for queued runs and retries and shown for running answers", () => {
  assert.doesNotMatch(row({ status: "queued" }), /Answer actions/);
  assert.doesNotMatch(row({ status: "failed" }, true), /Answer actions/);
  assert.match(row({ status: "running" }), /Answer actions/);
});

test("a message's state shows as a pill: Running, Queued, Failed, Stopped", () => {
  assert.deepEqual(researchMessagePill("running"), { label: "Running", tone: "run" });
  assert.deepEqual(researchMessagePill("queued"), { label: "Queued", tone: "plain" });
  assert.deepEqual(researchMessagePill("failed"), { label: "Failed", tone: "error" });
  assert.deepEqual(researchMessagePill("failed", true), { label: "Queued", tone: "plain" });
  assert.deepEqual(researchMessagePill("cancelled"), { label: "Stopped", tone: "plain" });
  assert.equal(researchMessagePill("complete"), null);
});

test("the running status line adds the latest activity when there is one", () => {
  assert.equal(runStatusText("running", false, "reading lesswrong.com"), "Working · reading lesswrong.com");
  assert.equal(runStatusText("running", false, null), "Working");
  assert.equal(runStatusText("starting", false, "ignored"), "Starting…");
  assert.equal(runStatusText("queued", true), "Queued. Starts when the running answer finishes.");
});
