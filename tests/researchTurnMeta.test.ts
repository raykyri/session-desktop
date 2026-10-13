import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchMessageRow,
  researchMessageState,
  researchMessageStateWord,
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
      retryQueued,
      branchCount: 2,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: false,
      registerSegmentElement: noop,
      onSelect: noop,
      onToggleBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
    }),
  );

test("the answer's … menu button appears in the row's corner pill after the branch indicator", () => {
  const html = row();
  // The indicator alone is no meta line: it sits at the row's right end.
  assert.doesNotMatch(html, /class="research-msg-meta"/);
  assert.match(html, /class="research-msg-row is-status-complete is-selected has-branches"/);
  const content = html.indexOf('class="research-msg-content"');
  const branch = html.indexOf('aria-label="2 branches from this answer."');
  const rail = html.indexOf('class="research-feed-rail"');
  assert.ok(content >= 0 && branch > content && rail > branch);
  const pill = html.slice(rail);
  assert.match(
    pill,
    /^class="research-feed-rail"><button type="button" class="research-feed-icon-button research-feed-card-menu" title="Answer details and actions" aria-label="Answer actions" aria-haspopup="menu" aria-expanded="false" tabindex="0"/,
  );
});

test("a row whose menu is open keeps its pill shown", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchMessageRow, {
      node: node(),
      level: 0,
      label: "A question",
      showPrompt: true,
      selected: false,
      branchCount: 0,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: true,
      registerSegmentElement: noop,
      onSelect: noop,
      onToggleBranches: noop,
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

test("a message's state: a queued Retry is queued; Queued and Stopped are also words", () => {
  assert.equal(researchMessageState("running"), "running");
  assert.equal(researchMessageState("starting"), "running");
  assert.equal(researchMessageState("failed"), "failed");
  assert.equal(researchMessageState("cancelled"), "stopped");
  assert.equal(researchMessageState("complete"), "answered");
  // A queued Retry of a failed message shows as queued, not as the failure.
  assert.equal(researchMessageState("failed", true), "queued");

  assert.equal(researchMessageStateWord("queued"), "Queued");
  assert.equal(researchMessageStateWord("stopped"), "Stopped");
  for (const state of ["running", "failed", "answered"] as const) {
    assert.equal(researchMessageStateWord(state), null);
  }
});

test("a message row starts its text with a glyph unless it is an answered exchange", () => {
  for (const [status, retry, shape, label] of [
    ["running", false, "running", "Running"],
    ["starting", false, "running", "Running"],
    ["failed", false, "failed", "Failed"],
    ["queued", false, "queued", "Queued"],
    ["failed", true, "queued", "Queued"],
    ["cancelled", false, "stopped", "Stopped"],
  ] as const) {
    const html = row({ status }, retry);
    const glyph = new RegExp(
      `<span class="research-row-glyph is-${shape}[^"]*" role="img" aria-label="${label}" title="${label}"><svg`,
    );
    const match = html.match(glyph);
    assert.ok(match, html);
    // The glyph is the first thing in the labelled text, before the
    // Markdown, so the row's button name starts with the state.
    const labelledBy = html.match(/class="research-msg-hit"[^>]*aria-labelledby="([^"]+)"/)?.[1] ?? "";
    assert.doesNotMatch(labelledBy, / /);
    const content = html.indexOf(`<div id="${labelledBy}" class="research-msg-content"`);
    assert.ok(content >= 0 && content < match.index!);
    assert.ok(match.index! < html.indexOf("turn-markdown"));
    assert.doesNotMatch(html, /research-msg-pill|research-feed-status/);
  }
  // Queued and Stopped keep their word as plain meta text, with no pill.
  assert.match(row({ status: "failed" }, true), /<span class="research-msg-state">Queued<\/span>/);
  assert.match(row({ status: "cancelled" }), /<span class="research-msg-state">Stopped<\/span>/);
  // An answered exchange shows no glyph.
  assert.doesNotMatch(row(), /research-row-glyph/);
});

test("a note, link, X post or document row shows its kind's glyph in the messages column", () => {
  const kinds: [NodeFixture, string][] = [
    [{ type: "post", prompt: "A note" }, "note"],
    [{ type: "post", format: "link", prompt: "https://example.com/a" }, "link"],
    [{ type: "document", source: "imported" }, "imported"],
    [{ type: "document", source: "transcript" }, "transcript"],
  ];
  for (const [overrides, shape] of kinds) {
    const html = row(overrides);
    assert.match(html, new RegExp(`<span class="research-row-glyph is-${shape}" aria-hidden="true">`), shape);
  }
});

test("the running status line adds the latest activity when there is one", () => {
  assert.equal(runStatusText("running", "reading lesswrong.com"), "Working · reading lesswrong.com");
  assert.equal(runStatusText("running", null), "Working");
  assert.equal(runStatusText("starting", "ignored"), "Starting…");
  // A queued run's line is the state alone.
  assert.equal(runStatusText("queued"), "Queued");
});
