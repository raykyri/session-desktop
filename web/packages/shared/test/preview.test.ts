import test from "ava";

import {
  RESEARCH_TITLE_MAX_CHARS,
  defaultTitle,
  normalizedPrefix,
  normalizedText,
  responsePreview,
  sanitizeResearchTitle,
} from "../src/research/preview.js";
import type { Turn, TurnBlock } from "../src/types/turn.js";

function turn(role: string, blocks: TurnBlock[]): Turn {
  return { id: "t1", agentId: "node-1", role, blocks, sourceIndex: 0 };
}

function text(value: string): TurnBlock {
  return { type: "text", text: value };
}

const toolUse: TurnBlock = { type: "toolUse", id: "call-1", name: "web_search", input: {} };

function codePoints(value: string): number {
  return [...value].length;
}

test("normalized text collapses every whitespace run", (t) => {
  t.is(normalizedText("  a   short\nquestion  "), "a short question");
  t.is(normalizedText(" \n\t "), "");
  t.is(normalizedText("one two"), "one two");
});

test("the normalized prefix stops at the code-point limit", (t) => {
  t.deepEqual(normalizedPrefix("one two three", 7), { value: "one two", truncated: true });
  t.deepEqual(normalizedPrefix("one two", 7), { value: "one two", truncated: false });
  t.deepEqual(normalizedPrefix("one two", 8), { value: "one two", truncated: false });
  // Astral characters count once, not twice, and are never split.
  const flags = "🇦🇶".repeat(4);
  const prefix = normalizedPrefix(flags, 3);
  t.true(prefix.truncated);
  t.is(codePoints(prefix.value), 3);
  t.is(prefix.value, "🇦🇶🇦");
});

test("titles normalize and truncate prompts", (t) => {
  t.is(defaultTitle("  a   short\nquestion  "), "a short question");
  const title = defaultTitle("x".repeat(80));
  t.is(codePoints(title), 73);
  t.true(title.endsWith("…"));
  t.is(defaultTitle("  \n "), "Untitled research");
});

test("a title cut at a word boundary keeps no trailing space", (t) => {
  const title = defaultTitle(`${"x".repeat(72)} tail`);
  t.is(title, `${"x".repeat(72)}…`);
});

test("generated titles are sanitized and bounded", (t) => {
  t.is(sanitizeResearchTitle("  Title: `Research   query titles.` "), "Research query titles");
  t.is(sanitizeResearchTitle("\n\t"), undefined);
  t.is(sanitizeResearchTitle('"Quoted"'), "Quoted");
  t.is(sanitizeResearchTitle("Controlcharacters"), "Control characters");
  const title = sanitizeResearchTitle("x".repeat(100));
  t.is(codePoints(title ?? ""), RESEARCH_TITLE_MAX_CHARS);
  t.true((title ?? "").endsWith("…"));
});

test("previews keep only wikilink display text", (t) => {
  t.is(
    responsePreview([
      turn("user", [text("Question")]),
      turn("assistant", [text("Use [[Rust]] with [[Tokio|tokio's]] runtime.")]),
    ]),
    "Use Rust with tokio's runtime.",
  );
});

test("stripping happens before the cut, so a marker never straddles it", (t) => {
  const lead = `${"word ".repeat(41)}ab `;
  const preview = responsePreview([
    turn("user", [text("Question")]),
    turn("assistant", [text(`${lead}[[Linked term]] continues here`)]),
  ]);
  t.false((preview ?? "").includes("[["));
  t.true((preview ?? "").includes("Linked term"));
  t.true((preview ?? "").endsWith("…"));
  // The cut fell on a word boundary: 219 characters, the trailing space
  // dropped, then the ellipsis.
  t.is(codePoints(preview ?? ""), 220);
});

test("the preview is the prose after the last tool activity", (t) => {
  t.is(
    responsePreview([
      turn("assistant", [text("Let me search."), toolUse]),
      turn("assistant", [text("The answer.")]),
    ]),
    "The answer.",
  );
  // A trailing housekeeping tool call clears the tail, and the fallback is
  // the first assistant prose in the response — the desktop's fold.
  t.is(
    responsePreview([
      turn("assistant", [text("Let me search."), toolUse]),
      turn("assistant", [text("The answer.")]),
      turn("assistant", [toolUse]),
    ]),
    "Let me search.",
  );
  // A raw block on an assistant turn is reasoning, not the answer's tail.
  t.is(
    responsePreview([
      turn("assistant", [text("First prose."), { type: "raw", value: { thinking: "private" } }]),
    ]),
    "First prose.",
  );
});

test("previews ignore user turns, empty text, and inactive turns", (t) => {
  t.is(responsePreview([]), undefined);
  t.is(responsePreview([turn("user", [text("Question")])]), undefined);
  t.is(responsePreview([turn("assistant", [text("   ")])]), undefined);
  t.is(
    responsePreview([
      { ...turn("assistant", [text("Superseded.")]), status: "superseded" },
      { ...turn("assistant", [text("Rolled back.")]), contextStatus: "rolledBack" },
    ]),
    undefined,
  );
});

test("previews count code points, not code units", (t) => {
  const preview = responsePreview([turn("assistant", [text("é".repeat(400))])]);
  t.is(codePoints(preview ?? ""), 221);
  t.is(codePoints((preview ?? "").replace("…", "")), 220);
});
