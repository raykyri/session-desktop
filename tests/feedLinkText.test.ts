import assert from "node:assert/strict";
import test from "node:test";
import { collapseBlankLines, feedTextRuns, splitNoteHeading } from "../src/lib/feedLinkText";

test("feed text splits http(s) URLs from the text around them", () => {
  assert.deepEqual(feedTextRuns("See https://example.com/a?b=1 for details"), [
    { kind: "text", text: "See " },
    { kind: "url", text: "https://example.com/a?b=1" },
    { kind: "text", text: " for details" },
  ]);
  assert.deepEqual(feedTextRuns("no links here"), [{ kind: "text", text: "no links here" }]);
});

test("trailing sentence punctuation stays outside the URL, a URL's own parenthesis stays in", () => {
  assert.deepEqual(feedTextRuns("Read http://a.org/x."), [
    { kind: "text", text: "Read " },
    { kind: "url", text: "http://a.org/x" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(feedTextRuns("(https://a.org/y), then"), [
    { kind: "text", text: "(" },
    { kind: "url", text: "https://a.org/y" },
    { kind: "text", text: "), then" },
  ]);
  assert.deepEqual(feedTextRuns("https://en.wikipedia.org/wiki/Foo_(bar)"), [
    { kind: "url", text: "https://en.wikipedia.org/wiki/Foo_(bar)" },
  ]);
});

test("blank lines between a note's paragraphs collapse to one line break", () => {
  assert.equal(collapseBlankLines("One\n\nTwo\n\n\n\nThree"), "One\nTwo\nThree");
  assert.equal(collapseBlankLines("One\n  \n\t\nTwo"), "One\nTwo");
  assert.equal(collapseBlankLines("One\r\n\r\nTwo"), "One\nTwo");
  assert.equal(collapseBlankLines("One\nTwo"), "One\nTwo");
  assert.equal(collapseBlankLines("No breaks"), "No breaks");
});

test("a note's first-line Markdown heading is split from the rest", () => {
  assert.deepEqual(splitNoteHeading("# Wikisim\nCompelling demo"), { heading: "Wikisim", rest: "Compelling demo" });
  assert.deepEqual(splitNoteHeading("### Plan ###"), { heading: "Plan", rest: "" });
  assert.deepEqual(splitNoteHeading("Plain first line\n# Later heading"), { heading: null, rest: "Plain first line\n# Later heading" });
  assert.deepEqual(splitNoteHeading("#hashtag only"), { heading: null, rest: "#hashtag only" });
  assert.deepEqual(splitNoteHeading("#   \nBody"), { heading: null, rest: "#   \nBody" });
});
