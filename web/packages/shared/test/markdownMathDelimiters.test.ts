import test from "ava";

import { normalizeLatexMathDelimiters } from "../src/markdown/mathDelimiters.js";

test("normalizes block and inline LaTeX delimiters", (t) => {
  t.is(normalizeLatexMathDelimiters("\\[\nx^2\n\\]"), "$$\nx^2\n$$");
  t.is(normalizeLatexMathDelimiters("before \\(x^2\\) after"), "before $x^2$ after");
});

test("leaves unmatched and explicitly escaped delimiters untouched", (t) => {
  t.is(normalizeLatexMathDelimiters("unmatched \\(x"), "unmatched \\(x");
  t.is(normalizeLatexMathDelimiters("literal \\\\(x\\)"), "literal \\\\(x\\)");
});

test("does not normalize delimiters in Markdown code", (t) => {
  const markdown = [
    "`\\(inline\\)`",
    "````",
    "\\[",
    "fenced",
    "\\]",
    "````",
    "    \\(indented\\)",
    "outside \\(math\\)",
  ].join("\n");
  const normalized = normalizeLatexMathDelimiters(markdown);
  t.is(
    normalized,
    [
      "`\\(inline\\)`",
      "````",
      "\\[",
      "fenced",
      "\\]",
      "````",
      "    \\(indented\\)",
      "outside $math$",
    ].join("\n"),
  );
});

test("supports tilde fences and backtick code spans with embedded runs", (t) => {
  t.is(
    normalizeLatexMathDelimiters("~~~tex\n\\(literal\\)\n~~~\n\\(math\\)"),
    "~~~tex\n\\(literal\\)\n~~~\n$math$",
  );
  t.is(
    normalizeLatexMathDelimiters("``code ` \\(literal\\)`` then \\(math\\)"),
    "``code ` \\(literal\\)`` then $math$",
  );
});
