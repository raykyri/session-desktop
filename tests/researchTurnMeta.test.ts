import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchTurnQuestion, runStatusText } from "../src/components/research/ResearchTurn";
import type { ResearchNode } from "../src/types";

const noop = () => {};

function node(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "n1",
    treeId: "tree",
    prompt: "A question",
    adapter: "claude",
    groupId: "ws",
    worktreeDir: "/ws",
    status: "complete",
    nativeSessionId: "session",
    createdAt: 0,
    highlights: [],
    ...overrides,
  };
}

const question = (overrides: Partial<ResearchNode> = {}) =>
  renderToStaticMarkup(
    createElement(ResearchTurnQuestion, {
      node: node(overrides),
      showPrompt: true,
      now: 60_000,
      promotable: true,
      branchCount: 2,
      onTogglePromoted: noop,
      onBranchButton: noop,
      onOpenAnswerMenu: noop,
    }),
  );

test("the answer's … menu button follows the star and branch buttons in the question's meta row", () => {
  const html = question();
  const meta = html.slice(html.indexOf('class="research-turn-meta"'));
  const star = meta.indexOf('aria-label="Star"');
  const branch = meta.indexOf('aria-label="2 branches from this answer"');
  const more = meta.indexOf('aria-label="Answer actions"');
  assert.ok(star >= 0 && branch > star && more > branch);
  assert.match(meta, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="Answer actions"/);
});

test("a queued run has no answer menu button yet; a running one has", () => {
  assert.doesNotMatch(question({ status: "queued" }), /Answer actions/);
  assert.match(question({ status: "running" }), /Answer actions/);
});

test("the running status line adds the latest activity when there is one", () => {
  assert.equal(runStatusText({ status: "running" }, false, "reading lesswrong.com"), "Working · reading lesswrong.com");
  assert.equal(runStatusText({ status: "running" }, false, null), "Working");
  assert.equal(runStatusText({ status: "starting" }, false, "ignored"), "Starting…");
  assert.equal(runStatusText({ status: "queued" }, true), "Queued. Starts when the running answer finishes.");
});
