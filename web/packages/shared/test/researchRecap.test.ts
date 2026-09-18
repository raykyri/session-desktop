import test from "ava";

import {
  DEFAULT_RECAP_INSTRUCTIONS,
  MAX_RECAP_INSTRUCTIONS_CHARS,
  MAX_RECAP_SOURCE_BYTES,
  MIN_RECAP_CHARS,
  extractRecapSource,
  normalizeRecap,
  recapJobKey,
  recapSourceFitsBudget,
  recapSourceForNode,
  shouldScheduleRecap,
  validateRecapInstructions,
} from "../src/research/recap.js";
import type { ResearchNode } from "../src/types/research.js";
import type { Turn, TurnBlock } from "../src/types/turn.js";

function turn(role: string, blocks: TurnBlock[]): Turn {
  return { id: "t1", agentId: "node-1", role, blocks, sourceIndex: 0 };
}

function text(value: string): TurnBlock {
  return { type: "text", text: value };
}

const toolUse: TurnBlock = { type: "toolUse", id: "call-1", name: "search", input: {} };

function recapSource(turns: Turn[]): string | undefined {
  return extractRecapSource(turns, false);
}

function node(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "node-1",
    treeId: "tree-1",
    workspaceId: "workspace-1",
    prompt: "Question",
    documentIds: [],
    model: "claude-sonnet",
    status: "complete",
    attempt: 1,
    responseSnapshotAt: 1_700_000_000_000,
    createdAt: 1,
    highlights: [],
    ...overrides,
  };
}

test("the default instructions are copied verbatim", (t) => {
  t.true(
    DEFAULT_RECAP_INSTRUCTIONS.startsWith(
      "Write a compact recap that directly answers the user's question using only the supplied answer.",
    ),
  );
  t.true(DEFAULT_RECAP_INSTRUCTIONS.includes("Usually use 30-70 words."));
  t.true(DEFAULT_RECAP_INSTRUCTIONS.endsWith("Do not merely describe what the answer discusses."));
});

test("recap source and output keep only wikilink display text", (t) => {
  const body = `[[Rust]] and [[Tokio|tokio's]] runtime. ${"x".repeat(800)}`;
  const source = recapSource([turn("assistant", [text(body)])]);
  t.true((source ?? "").startsWith("Rust and tokio's runtime."));
  t.is(normalizeRecap("Summary: [[Rust]] wins."), "Rust wins.");
});

test("the cutoff counts visible unicode text, not link targets or markup", (t) => {
  t.is(recapSource([turn("assistant", [text("é".repeat(MIN_RECAP_CHARS - 1))])]), undefined);
  t.not(recapSource([turn("assistant", [text(`**${"é".repeat(MIN_RECAP_CHARS)}**`)])]), undefined);
  t.is(
    recapSource([turn("assistant", [text(`[short](https://example.com/${"x".repeat(1000)})`)])]),
    undefined,
  );
});

test("the source excludes the prompt, reasoning, and tool activity", (t) => {
  const answer = "Final answer. ".repeat(70).trim();
  const turns = [
    turn("user", [text("question".repeat(200))]),
    turn("assistant", [text("commentary".repeat(200)), toolUse]),
    turn("assistant", [{ type: "raw", value: { thinking: "private reasoning" } }, text(answer)]),
  ];
  t.is(recapSource(turns), answer);
  // A trailing housekeeping tool call folds back to the last text group.
  t.is(recapSource([...turns, turn("assistant", [toolUse])]), answer);
});

test("markdown structure becomes plain prose", (t) => {
  const markdown = [
    "# Heading",
    "",
    "A paragraph with **strong**, *emphasis*, `code`, and a [link](https://example.com).",
    "",
    "- First item",
    "- Second item",
    "",
    "> Quoted line",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```js",
    "const answer = 1;",
    "```",
    "",
    "---",
  ].join("\n");
  t.is(
    extractRecapSource([turn("assistant", [text(markdown)])], true),
    "Heading A paragraph with strong, emphasis, code, and a link. First item Second item Quoted line a b 1 2 const answer = 1;",
  );
  // Intraword underscores and a lone asterisk are not emphasis delimiters.
  t.is(
    extractRecapSource([turn("assistant", [text("snake_case_name and 2 * 3")])], true),
    "snake_case_name and 2 * 3",
  );
});

test("an imported report is summarized however short it is", (t) => {
  const turns = [turn("assistant", [text("Short imported report.")])];
  t.is(extractRecapSource(turns, false), undefined);
  t.is(extractRecapSource(turns, true), "Short imported report.");
  t.is(extractRecapSource([turn("assistant", [text("  ")])], true), undefined);
  t.is(recapSourceForNode(node({ origin: "imported" }), turns), "Short imported report.");
  t.is(recapSourceForNode(node(), turns), undefined);
});

test("an oversized source is skipped unless the report was imported", (t) => {
  const huge = "word ".repeat(MAX_RECAP_SOURCE_BYTES / 4);
  t.is(extractRecapSource([turn("assistant", [text(huge)])], false), undefined);
  t.not(extractRecapSource([turn("assistant", [text(huge)])], true), undefined);
  // The prompt is charged against the same budget as the answer.
  const source = "x".repeat(MAX_RECAP_SOURCE_BYTES - 10);
  t.true(recapSourceFitsBudget(node({ prompt: "short" }), source));
  t.false(recapSourceFitsBudget(node({ prompt: "a longer question" }), source));
  t.true(recapSourceFitsBudget(node({ prompt: "a longer question", origin: "imported" }), source));
});

test("a recap is plain and bounded", (t) => {
  t.is(
    normalizeRecap("**Summary:** *Primary result.*\nThen [secondary result](https://example.com)."),
    "Primary result. Then secondary result.",
  );
  t.is(normalizeRecap("summary: lowercase label."), "lowercase label.");
  t.is(normalizeRecap(" \n "), undefined);
  t.is(normalizeRecap("x".repeat(1_201)), undefined);
  t.is(normalizeRecap("x".repeat(1_200)), "x".repeat(1_200));
});

test("custom instructions are non-empty and bounded", (t) => {
  t.is(validateRecapInstructions("  Preserve caveats.  "), "Preserve caveats.");
  t.regex(
    t.throws(() => validateRecapInstructions(" \n "))?.message ?? "",
    /summary instructions cannot be empty/,
  );
  t.regex(
    t.throws(() => validateRecapInstructions("x".repeat(MAX_RECAP_INSTRUCTIONS_CHARS + 1)))
      ?.message ?? "",
    /cannot exceed 4000 characters/,
  );
  t.notThrows(() => validateRecapInstructions("é".repeat(MAX_RECAP_INSTRUCTIONS_CHARS)));
});

test("only a settled run without a recap is scheduled", (t) => {
  t.true(shouldScheduleRecap(node()));
  t.true(shouldScheduleRecap(node({ kind: "run" })));
  t.false(shouldScheduleRecap(node({ kind: "document" })));
  t.false(shouldScheduleRecap(node({ status: "running" })));
  t.false(shouldScheduleRecap(node({ status: "failed" })));
  t.false(shouldScheduleRecap(node({ responseSnapshotAt: null })));
  t.false(
    shouldScheduleRecap(node({ recap: { text: "Done.", responseRevision: "a".repeat(64) } })),
  );
});

test("the job key changes only with a new answer", (t) => {
  t.is(recapJobKey(node()), recapJobKey(node({ status: "running" })));
  t.not(recapJobKey(node()), recapJobKey(node({ responseSnapshotAt: 2 })));
  t.not(recapJobKey(node()), recapJobKey(node({ id: "node-2" })));
});
