// The content-derived half of a segment (`09-research-document-view.md` §7):
// which turns become the answer, what the empty-state cascade says, and what
// the Sources footer reads out of the recorded tool results.

import type { ResearchNode, Turn } from "@session/shared";
import test from "ava";

import { TIMELINE_ITEM_RENDER_WINDOW } from "../src/features/research/layout.js";
import { researchSources } from "../src/features/research/sources.js";
import {
  answerEmptyStateText,
  buildSegmentView,
  durationLabel,
  formatRunDuration,
  statusLabel,
  timelineTurns,
} from "../src/features/research/timeline.js";

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
    node: node({ kind: "document", status: "complete" }),
  });
  t.true(built.isDocument);
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

/* ----------------------------------------------------------- empty states */

function emptyFor(overrides: Partial<ResearchNode>, hasAnyTimelineItem = false): string | null {
  return answerEmptyStateText({
    node: node(overrides),
    sourceError: undefined,
    hasAnyTimelineItem,
  });
}

test("empty state renders the specific error or completion message", (t) => {
  t.is(emptyFor({ status: "failed", error: "provider refused" }), "provider refused");
  t.is(emptyFor({ status: "cancelled" }), "The run was cancelled.");
  t.is(emptyFor({ status: "interrupted" }), "The run was interrupted. Resuming…");
  // The status line already reads "Working…"; the empty state stays silent.
  t.is(emptyFor({ status: "running" }), null);
  t.is(emptyFor({ status: "queued" }), null);
  t.is(emptyFor({ status: "running" }, true), "Generating response…");
  t.is(emptyFor({ status: "complete" }), "The run finished, but the answer could not be loaded.");
});

test("source error state takes display precedence over normal completion status", (t) => {
  t.is(
    answerEmptyStateText({
      node: node({ status: "complete" }),
      sourceError: "the snapshot was pruned",
      hasAnyTimelineItem: false,
    }),
    "The response is no longer available: the snapshot was pruned",
  );
});

/* ----------------------------------------------------------------- timing */

test("durations read as minutes and seconds once past a minute", (t) => {
  t.is(formatRunDuration(45_000), "45s");
  t.is(formatRunDuration(68_000), "1m 08s");
  t.is(formatRunDuration(3_700_000), "1h 1m");
});

test("the duration line says what the run is doing", (t) => {
  const started = node({ status: "running", startedAt: 1_000, completedAt: null });
  t.is(durationLabel(started, 6_000), "Generating for 5s");
  const done = node({ status: "complete", startedAt: 1_000, completedAt: 4_000 });
  t.is(durationLabel(done, 9_999), "3s");
  const failed = node({ status: "failed", startedAt: 1_000, completedAt: 3_000 });
  t.is(durationLabel(failed, 9_999), "Ran for 2s");
  t.is(durationLabel(node({ status: "queued", startedAt: null }), 0), "Waiting to start");
  t.is(durationLabel(node({ status: "cancelled", startedAt: null }), 0), null);
});

test("every status has a label", (t) => {
  t.is(statusLabel("queued"), "Queued");
  t.is(statusLabel("running"), "Working…");
  t.is(statusLabel("interrupted"), "Interrupted");
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
  // With no title the domain stands in.
  t.is(sources[0]?.title, "ok.example");
});

test("a grounded search contributes its titles and its entry point", (t) => {
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
