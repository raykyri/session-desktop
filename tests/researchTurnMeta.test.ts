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
      now: 60_000,
      starrable: true,
      retryQueued,
      branchCount: 2,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: false,
      registerSegmentElement: noop,
      onSelect: noop,
      onToggleStarred: noop,
      onShowBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
    }),
  );

test("the answer's … menu button follows the star and branch count in the message's meta line", () => {
  const html = row();
  const meta = html.slice(html.indexOf('class="research-msg-meta"'));
  const star = meta.indexOf('aria-label="Star"');
  const branch = meta.indexOf('aria-label="2 branches from this answer"');
  const more = meta.indexOf('aria-label="Answer actions"');
  assert.ok(star >= 0 && branch > star && more > branch);
  assert.match(meta, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="Answer actions"/);
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
