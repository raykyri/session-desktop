import test from "ava";

import {
  MAX_ENCYCLOPEDIA_EXCERPT_CHARS,
  MAX_ENCYCLOPEDIA_EXISTING_PAGES_IN_PROMPT,
  MAX_ENCYCLOPEDIA_QUESTION_CHARS,
  MAX_ENCYCLOPEDIA_SIBLING_TERMS,
  MAX_ENCYCLOPEDIA_SOURCES_IN_PROMPT,
  MAX_ENCYCLOPEDIA_TITLE_CHARS,
  normalizePage,
  splitTitle,
  truncateEncyclopediaText,
} from "../src/encyclopedia/title.js";

test("a generated page keeps its leading heading as the title", (t) => {
  t.deepEqual(splitTitle("# Daemon (novel)\n\nA 2006 techno-thriller.", "Daemon"), {
    title: "Daemon (novel)",
    body: "A 2006 techno-thriller.",
  });
  // Closing hashes and wikilinks in the heading are not part of the title.
  t.deepEqual(splitTitle("# [[Daemon]] ##\nbody", "Daemon"), { title: "Daemon", body: "body" });
});

test("a page without a usable heading keeps the term as its title", (t) => {
  t.deepEqual(splitTitle("No heading here.", "Daemon"), {
    title: "Daemon",
    body: "No heading here.",
  });
  // An empty heading is not a title, and the line stays in the body.
  t.deepEqual(splitTitle("# \nbody", "Daemon"), { title: "Daemon", body: "# \nbody" });
});

test("ignores leading non-heading text and preserves the first valid heading", (t) => {
  t.deepEqual(splitTitle("ic# ORCID\n\n**ORCID** is…", "ORCID"), {
    title: "ORCID",
    body: "**ORCID** is…",
  });
  t.deepEqual(splitTitle("A long intro sentence first.\n# Later", "ORCID"), {
    title: "ORCID",
    body: "A long intro sentence first.\n# Later",
  });
});

test("titles collapse whitespace and are cut at the character cap", (t) => {
  const long = "word ".repeat(200).trim();
  const { title } = splitTitle(`# ${long}\nbody`, "Term");
  t.is([...title].length, MAX_ENCYCLOPEDIA_TITLE_CHARS + 1);
  t.true(title.endsWith("…"));
  t.is(truncateEncyclopediaText("  spaced   out\n text ", 100), "spaced out text");
  t.is(truncateEncyclopediaText("abcdef", 3), "abc…");
});

test("a JSON-encoded page is unwrapped, up to three layers deep", (t) => {
  t.is(normalizePage("  # T\n\nbody "), "# T\n\nbody");
  t.is(normalizePage('{"page":"# T\\n\\nbody"}'), "# T\n\nbody");
  t.is(normalizePage('{"page":"{\\"page\\":\\"# T\\"}"}'), "# T");
  // Objects without a page string are left as text for the reader to see.
  t.is(normalizePage('{"other":1}'), '{"other":1}');
  t.is(normalizePage("   "), null);
  t.is(normalizePage('{"page":""}'), null);
});

test("prompt assembly caps match the desktop backend", (t) => {
  t.is(MAX_ENCYCLOPEDIA_TITLE_CHARS, 160);
  t.is(MAX_ENCYCLOPEDIA_QUESTION_CHARS, 600);
  t.is(MAX_ENCYCLOPEDIA_EXCERPT_CHARS, 4_000);
  t.is(MAX_ENCYCLOPEDIA_SIBLING_TERMS, 24);
  t.is(MAX_ENCYCLOPEDIA_SOURCES_IN_PROMPT, 5);
  t.is(MAX_ENCYCLOPEDIA_EXISTING_PAGES_IN_PROMPT, 120);
});
