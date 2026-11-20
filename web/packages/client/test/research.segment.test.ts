// Segment view content projection (`09-research-document-view.md` §7):
// turn-to-answer projection, run status formatting, run control state,
// and source extraction from tool results.

import type { Turn } from "@session/shared";
import test from "ava";

import { runStatusText } from "../src/features/thread/Turn.js";
import { runActive, runRetryable } from "../src/features/thread/runState.js";
import {
  TIMELINE_ITEM_RENDER_WINDOW,
  buildSegmentView,
  timelineTurns,
} from "../src/features/thread/segmentView.js";
import { researchSources } from "../src/features/thread/sources.js";

import { node } from "./fixtures.js";

function assistantTurn(id: string, text: string): Turn {
  return {
    id,
    agentId: "n1",
    role: "assistant",
    blocks: [{ type: "text", text }],
    sourceIndex: 0,
  };
}

function toolTurn(id: string, name: string, input: unknown, result: unknown): Turn {
  return {
    id,
    agentId: "n1",
    role: "assistant",
    blocks: [
      { type: "toolUse", id: `${id}-u`, name, input },
      { type: "toolResult", toolUseId: `${id}-u`, content: result, isError: false },
    ],
    sourceIndex: 0,
  };
}

function view(turns: Turn[], overrides: Partial<Parameters<typeof buildSegmentView>[0]> = {}) {
  return buildSegmentView({
    node: node({ status: "complete" }),
    content: undefined,
    turns,
    showAllTurns: false,
    showFullTrace: false,
    ...overrides,
  });
}

/* -------------------------------------------------------------- in-flight */

test("in-flight text becomes a trailing assistant turn under the streamed turn id", (t) => {
  const committed = [assistantTurn("t1", "First. ")];
  const turns = timelineTurns("n1", committed, "Second.", "t2");
  t.is(turns.length, 2);
  t.is(turns[1]?.id, "t2");
  t.is(turns[1]?.role, "assistant");
});

test("with no streamed turn id the synthetic turn is named after the node", (t) => {
  const turns = timelineTurns("n1", [], "partial", null);
  t.is(turns[0]?.id, "n1::in-flight");
});

test("returns committed turns unchanged when in-flight text is empty", (t) => {
  const committed = [assistantTurn("t1", "done")];
  t.is(timelineTurns("n1", committed, "", null), committed);
});

test("timeline React key remains stable when streaming block transitions to committed turn", (t) => {
  // While streaming: one committed turn plus the growing tail.
  const streaming = view(timelineTurns("n1", [assistantTurn("t1", "A")], "B", "t2"));
  // After the commit: the same two turns, the second now durable.
  const settled = view([assistantTurn("t1", "A"), assistantTurn("t2", "B")]);
  t.deepEqual(
    streaming.visibleTimelineItems.map((item) => item.key),
    settled.visibleTimelineItems.map((item) => item.key),
  );
});

/* ------------------------------------------------------------- projection */

test("the collapsed answer starts after the last tool call", (t) => {
  const built = view([
    assistantTurn("t1", "Let me look."),
    toolTurn("t2", "web_search", { query: "memory" }, { results: [] }),
    assistantTurn("t3", "Here is the answer."),
  ]);
  t.is(built.rawAnswer, "Here is the answer.");
  t.true(built.hasTranscriptActivity);
  // The full trace keeps the earlier text and the activity row.
  t.true(built.timelineItems.length > built.displayedTimelineItems.length);
});

test("expanding trace view displays reasoning and intermediate tool executions", (t) => {
  const turns = [
    assistantTurn("t1", "Let me look."),
    toolTurn("t2", "web_search", { query: "memory" }, { results: [] }),
    assistantTurn("t3", "Here is the answer."),
  ];
  const collapsed = view(turns);
  const full = view(turns, { showFullTrace: true });
  t.is(full.displayedTimelineItems.length, full.timelineItems.length);
  t.true(full.displayedTimelineItems.length > collapsed.displayedTimelineItems.length);
});

test("a long trace renders its tail and reports the rest as hidden", (t) => {
  const turns = Array.from({ length: TIMELINE_ITEM_RENDER_WINDOW + 5 }, (_, index) =>
    // Alternating roles keep each turn its own timeline item.
    index % 2 === 0
      ? assistantTurn(`a${index}`, `answer ${index}`)
      : { ...assistantTurn(`u${index}`, `question ${index}`), role: "user" },
  );
  const built = view(turns);
  t.is(built.visibleTimelineItems.length, TIMELINE_ITEM_RENDER_WINDOW);
  t.is(
    built.hiddenTimelineItemCount,
    built.displayedTimelineItems.length - TIMELINE_ITEM_RENDER_WINDOW,
  );
  // The render window retains the most recent items.
  t.is(
    built.visibleTimelineItems[built.visibleTimelineItems.length - 1],
    built.displayedTimelineItems[built.displayedTimelineItems.length - 1],
  );
});

test("expanding the window shows every item", (t) => {
  const turns = Array.from({ length: TIMELINE_ITEM_RENDER_WINDOW + 5 }, (_, index) =>
    index % 2 === 0
      ? assistantTurn(`a${index}`, `answer ${index}`)
      : { ...assistantTurn(`u${index}`, `question ${index}`), role: "user" },
  );
  const built = view(turns, { showAllTurns: true });
  t.is(built.hiddenTimelineItemCount, 0);
});

test("a document root exposes its markdown for the editor", (t) => {
  const built = view([assistantTurn("t1", "# Report\n\nbody")], {
    node: node({ type: "document", status: "complete" }),
  });
  t.is(built.editableDocumentMarkdown, "# Report\n\nbody");
});

test("the word count counts the answer, not the trace", (t) => {
  const built = view([
    assistantTurn("t1", "one two three four five"),
    toolTurn("t2", "web_search", {}, { results: [] }),
    assistantTurn("t3", "six seven"),
  ]);
  t.is(built.answerWordCount, 2);
});

/* ------------------------------------------------------------- run state */

test("formats status line text for run states and queue positions", (t) => {
  t.is(runStatusText(node({ status: "queued" }), false, undefined), "Queued");
  t.is(runStatusText(node({ status: "queued" }), false, 2), "Queued · 2 ahead");
  t.is(runStatusText(node({ status: "queued" }), false, 0), "Queued");
  t.is(runStatusText(node({ status: "interrupted" }), false, undefined), "Interrupted · resuming");
  t.is(runStatusText(node({ status: "running" }), false, undefined), "Working");
  t.is(runStatusText(node({ status: "running" }), true, undefined), "Thinking");
  // Runs held for daily limits display hold reason instead of queue position.
  const held = "Queued until the daily research limit resets at midnight UTC.";
  t.is(runStatusText(node({ status: "queued", error: held }), false, 1), held);
});

test("an interrupted run is active while its resume is pending", (t) => {
  t.true(runActive(node({ status: "running" })));
  t.true(runActive(node({ status: "queued" })));
  t.true(runActive(node({ status: "interrupted" })));
  t.false(runRetryable(node({ status: "interrupted" })));
  // When resume is no longer pending, run transitions from active to retryable.
  const abandoned = node({ status: "interrupted", resumePending: false });
  t.false(runActive(abandoned));
  t.true(runRetryable(abandoned));
});

test("a failed or cancelled run can be retried, a complete one cannot", (t) => {
  t.true(runRetryable(node({ status: "failed" })));
  t.true(runRetryable(node({ status: "cancelled" })));
  t.false(runRetryable(node({ status: "complete" })));
  t.false(runActive(node({ status: "complete" })));
});

/* ---------------------------------------------------------------- sources */

test("sources are the distinct URLs of the searches and fetches", (t) => {
  const { sources } = researchSources([
    toolTurn(
      "t1",
      "web_search",
      { query: "memory" },
      {
        results: [
          { url: "https://a.example/one", title: "One", snippet: "…" },
          { url: "https://b.example/two", title: "Two", snippet: "…" },
        ],
      },
    ),
    toolTurn(
      "t2",
      "web_fetch",
      { url: "https://a.example/one" },
      { url: "https://a.example/one", title: "One, read", text: "…", truncated: false },
    ),
  ]);
  t.is(sources.length, 2);
  // The fetched page title takes precedence, and `www.` is removed from its domain.
  t.deepEqual(
    sources.map((source) => [source.title, source.domain, source.fetched]),
    [
      ["One, read", "a.example", true],
      ["Two", "b.example", false],
    ],
  );
});

test("document fetch preserves previously discovered search title when response title is empty", (t) => {
  const { sources } = researchSources([
    toolTurn(
      "t1",
      "web_search",
      { query: "memory" },
      { results: [{ url: "https://a.example/one", title: "One", snippet: "…" }] },
    ),
    toolTurn(
      "t2",
      "web_fetch",
      { url: "https://a.example/one" },
      { url: "https://a.example/one", text: "…", truncated: false },
    ),
  ]);
  t.deepEqual(
    sources.map((source) => [source.title, source.fetched]),
    [["One", true]],
  );
});

test("unsafe or non-HTTP source URLs are filtered out of the citations footer", (t) => {
  const { sources } = researchSources([
    toolTurn(
      "t1",
      "web_search",
      {},
      { results: [{ url: "javascript:alert(1)", title: "bad" }, { url: "https://ok.example/" }] },
    ),
  ]);
  t.deepEqual(
    sources.map((source) => source.url),
    ["https://ok.example/"],
  );
  // Falls back to domain when title is missing.
  t.is(sources[0]?.title, "ok.example");
});

test("extracts title and search entry point from grounded search results", (t) => {
  const { sources, searchEntryPoints } = researchSources([
    toolTurn(
      "t1",
      "google_search",
      { queries: ["memory"] },
      {
        results: [{ url: "https://g.example/x", title: "Grounded" }],
        searchEntryPoint: "<div>chips</div>",
      },
    ),
  ]);
  t.is(sources[0]?.title, "Grounded");
  t.deepEqual(searchEntryPoints, ["<div>chips</div>"]);
});

test("excludes failed tool results from source citations", (t) => {
  const failing: Turn = {
    id: "t1",
    agentId: "n1",
    role: "assistant",
    blocks: [
      { type: "toolUse", id: "u1", name: "web_fetch", input: {} },
      {
        type: "toolResult",
        toolUseId: "u1",
        content: { url: "https://x.example/" },
        isError: true,
      },
    ],
    sourceIndex: 0,
  };
  t.is(researchSources([failing]).sources.length, 0);
});
