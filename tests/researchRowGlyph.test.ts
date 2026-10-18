import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchRowGlyph from "../src/components/research/ResearchRowGlyph";
import {
  researchMessageRowHasGlyph,
  researchRowGlyph,
  researchRowKind,
  researchRowState,
  researchThreadKind,
  researchThreadState,
  type ResearchRowKind,
  type ResearchRowState,
} from "@session/shared/lib/researchRowGlyph";
import type { ResearchMessageAttachment, ResearchTreeSummary } from "../src/types";

const tweet: ResearchMessageAttachment = {
  kind: "tweet",
  schemaVersion: 1,
  sourceUrl: "https://x.com/example/status/1",
  tweetId: "1",
  placement: "trailing",
  provider: "xSyndication",
  status: "resolved",
  attemptedAt: 1,
  tweet: {
    id: "1",
    url: "https://x.com/example/status/1",
    runs: [{ kind: "text", text: "Tweet" }],
    partial: false,
    createdAt: "2025-02-02T23:17:00.000Z",
    author: { name: "Example", handle: "example" },
    media: [],
  },
};

test("a row's kind comes from its node type, a document's source and a post's format", () => {
  assert.equal(researchRowKind({}), "exchange");
  assert.equal(researchRowKind({ type: "exchange" }), "exchange");
  assert.equal(researchRowKind({ type: "post", format: "text" }), "note");
  assert.equal(researchRowKind({ type: "post" }), "note");
  assert.equal(researchRowKind({ type: "post", format: "link" }), "link");
  // A link post shows as its tweet once the tweet resolved.
  assert.equal(researchRowKind({ type: "post", format: "link", attachments: [tweet] }), "xpost");
  assert.equal(
    researchRowKind({ type: "post", format: "link", attachments: [{ ...tweet, status: "unavailable", tweet: undefined }] }),
    "link",
  );
  // A text post with a tweet in it is a note.
  assert.equal(researchRowKind({ type: "post", format: "text", attachments: [tweet] }), "note");
  assert.equal(researchRowKind({ type: "document", source: "imported" }), "imported");
  assert.equal(researchRowKind({ type: "document", source: "authored" }), "authored");
  assert.equal(researchRowKind({ type: "document", source: "transcript" }), "transcript");
  assert.equal(researchRowKind({ type: "document" }), "authored");
});

test("a run status maps to a row state", () => {
  assert.equal(researchRowState("queued"), "queued");
  assert.equal(researchRowState("starting"), "running");
  assert.equal(researchRowState("running"), "running");
  assert.equal(researchRowState("complete"), "answered");
  assert.equal(researchRowState("failed"), "failed");
  assert.equal(researchRowState("cancelled"), "stopped");
});

test("an exchange's glyph is a ring whose interior is its state", () => {
  const cases: [ResearchRowState, boolean, string, string | null, string | null][] = [
    ["queued", false, "queued", null, "Queued"],
    ["running", false, "running", "running", "Running"],
    ["answered", false, "answered", null, null],
    ["answered", true, "unread", "unread", "Updated"],
    ["failed", false, "failed", "failed", "Failed"],
    ["stopped", false, "stopped", null, "Stopped"],
    // Unread shows on an answered row only: the state already marks a change.
    ["failed", true, "failed", "failed", "Failed"],
    ["running", true, "running", "running", "Running"],
  ];
  for (const [state, unread, shape, tone, label] of cases) {
    assert.deepEqual(researchRowGlyph({ kind: "exchange", state, unread }), { shape, tone, label }, `${state} ${unread}`);
  }
});

test("other kinds keep their shape and take the thread state's colour", () => {
  const kinds: ResearchRowKind[] = ["note", "link", "xpost", "imported", "authored", "transcript", "draft"];
  for (const kind of kinds) {
    assert.deepEqual(researchRowGlyph({ kind }), { shape: kind, tone: null, label: null });
    assert.deepEqual(researchRowGlyph({ kind, state: "running" }), { shape: kind, tone: "running", label: "Running" });
    assert.deepEqual(researchRowGlyph({ kind, state: "failed" }), { shape: kind, tone: "failed", label: "Failed" });
    assert.deepEqual(researchRowGlyph({ kind, unread: true }), { shape: kind, tone: "unread", label: "Updated" });
  }
});

test("the messages column shows a glyph on every row but an answered exchange", () => {
  assert.equal(researchMessageRowHasGlyph("exchange", "answered"), false);
  for (const state of ["queued", "running", "failed", "stopped"] as const) {
    assert.equal(researchMessageRowHasGlyph("exchange", state), true);
  }
  for (const kind of ["note", "link", "xpost", "imported", "authored", "transcript"] as const) {
    assert.equal(researchMessageRowHasGlyph(kind, "answered"), true);
  }
});

const tree: ResearchTreeSummary = {
  id: "t", title: "T", rootNodeId: "root", type: "post", workspaceId: "ws",
  runningCount: 0, failedCount: 0, completedCount: 0, cancelledCount: 0, updatedAt: 0,
  hasUnseenUpdate: false, hasUnseenFailure: false,
};

test("a feed card's kind is its root's; its state is the thread's", () => {
  const root = { nodeId: "root", type: "post" as const, format: "link" as const, status: "complete" as const };
  assert.equal(researchThreadKind(tree, root), "link");
  // A follow-up standing in for an unloaded root does not set the kind.
  assert.equal(researchThreadKind(tree, { ...root, nodeId: "follow-up", type: "exchange" as const }), "note");
  assert.equal(researchThreadKind({ ...tree, type: "document" }, undefined), "authored");
  assert.equal(researchThreadKind(undefined, { ...root, nodeId: "x" }), "link");

  assert.equal(researchThreadState(tree, { status: "complete" }), "answered");
  assert.equal(researchThreadState({ ...tree, runningCount: 1 }, { status: "complete" }), "running");
  assert.equal(researchThreadState({ ...tree, runningCount: 1 }, { status: "queued" }), "queued");
  assert.equal(researchThreadState(tree, { status: "starting" }), "running");
  assert.equal(researchThreadState({ ...tree, hasUnseenFailure: true }, { status: "complete" }), "failed");
  assert.equal(researchThreadState(tree, { status: "failed" }), "failed");
  // A running follow-up outranks a failure.
  assert.equal(researchThreadState({ ...tree, runningCount: 1, hasUnseenFailure: true }, { status: "failed" }), "running");
  assert.equal(researchThreadState(tree, { status: "cancelled" }), "stopped");
  assert.equal(researchThreadState(undefined, undefined), "answered");
});

test("the glyph is a named image for a state with a name, and hidden otherwise", () => {
  const running = renderToStaticMarkup(createElement(ResearchRowGlyph, { kind: "exchange", state: "running", id: "g" }));
  assert.match(
    running,
    /^<span id="g" class="research-row-glyph is-running is-tone-running" role="img" aria-label="Running" title="Running"><svg viewBox="0 0 14 14" width="14" height="14"/,
  );
  // The pie pulses, not the ring.
  assert.match(running, /<circle cx="7" cy="7" r="5.6"><\/circle><path class="research-row-glyph-pulse"/);

  const failed = renderToStaticMarkup(
    createElement(ResearchRowGlyph, { kind: "exchange", state: "failed", label: "Failed since last viewed" }),
  );
  assert.match(failed, /aria-label="Failed since last viewed" title="Failed since last viewed"/);

  const answered = renderToStaticMarkup(createElement(ResearchRowGlyph, { kind: "exchange", id: "g" }));
  assert.match(answered, /^<span class="research-row-glyph is-answered" aria-hidden="true"><svg/);
  assert.doesNotMatch(answered, /id=|title=|role=/);

  // A note whose thread is running pulses its whole shape.
  const note = renderToStaticMarkup(createElement(ResearchRowGlyph, { kind: "note", state: "running" }));
  assert.match(note, /class="research-row-glyph is-note is-tone-running" role="img" aria-label="Running"[^>]*><svg class="research-row-glyph-pulse"/);

  // Dashed shapes use butt caps so the dashes stay apart.
  for (const [kind, state] of [["exchange", "queued"], ["draft", "answered"]] as const) {
    assert.match(
      renderToStaticMarkup(createElement(ResearchRowGlyph, { kind, state })),
      /stroke-dasharray="[^"]+" stroke-linecap="butt"/,
    );
  }
});
