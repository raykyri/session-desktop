import test from "ava";

import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  ResearchDocumentWordLimitExceeded,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
  stripImportedReportCitations,
} from "../src/research/documents.js";

test("word counting matches whitespace-delimited tokens", (t) => {
  t.is(countResearchDocumentWords(""), 0);
  t.is(countResearchDocumentWords("   \n\t"), 0);
  t.is(countResearchDocumentWords("one"), 1);
  t.is(countResearchDocumentWords("# Heading\n\nTwo  words\there\n"), 5);
  t.is(
    countResearchDocumentWords(Array(RESEARCH_DOCUMENT_WORD_LIMIT).fill("w").join(" ")),
    RESEARCH_DOCUMENT_WORD_LIMIT,
  );
});

test("limited word counting stops at the first word over the limit", (t) => {
  const markdown = Array(RESEARCH_DOCUMENT_WORD_LIMIT + 100)
    .fill("w")
    .join(" ");
  const error = t.throws<ResearchDocumentWordLimitExceeded>(
    () => countResearchDocumentWords(markdown, RESEARCH_DOCUMENT_WORD_LIMIT),
    {
      instanceOf: ResearchDocumentWordLimitExceeded,
      message: `Documents are limited to ${RESEARCH_DOCUMENT_WORD_LIMIT} words for now`,
    },
  );
  t.is(error?.limit, RESEARCH_DOCUMENT_WORD_LIMIT);
  t.is(error?.count, RESEARCH_DOCUMENT_WORD_LIMIT + 1);
});

test("word counting agrees with the server on the code points JS whitespace gets wrong", (t) => {
  // U+0085 NEL is Unicode White_Space (a separator to the server) but not
  // JavaScript whitespace; U+FEFF is the reverse.
  t.is(countResearchDocumentWords("a\u0085b"), 2);
  t.is(countResearchDocumentWords("a\uFEFFb"), 1);
  t.is(countResearchDocumentWords("a\u1680\u2007\u2028\u202F\u205F\u3000b"), 2);
});

test("derived titles prefer the first content line and strip heading markers", (t) => {
  t.is(deriveResearchDocumentTitle("\n\n## Quarterly Report\n\nBody"), "Quarterly Report");
  t.is(deriveResearchDocumentTitle("plain first line\nsecond"), "plain first line");
  // A heading-marker-only line has no content; the next line wins.
  t.is(deriveResearchDocumentTitle("#\nReal title"), "Real title");
  t.is(deriveResearchDocumentTitle("  \n\t"), "Untitled document");
});

test("derived titles use the server's White_Space rules for U+FEFF and U+0085", (t) => {
  // U+FEFF is JavaScript whitespace but NOT Unicode White_Space: like the
  // server, the BOM must stay before the heading marker, so the marker is not
  // stripped and the preview matches the persisted title.
  t.is(deriveResearchDocumentTitle("\uFEFF# Title"), "\uFEFF# Title");
  // U+0085 (NEL) is Unicode White_Space but not JavaScript whitespace: it must
  // trim away so the heading marker is recognized, matching the server.
  t.is(deriveResearchDocumentTitle("\u0085Real title"), "Real title");
});

test("derived titles normalize whitespace and truncate like server titles", (t) => {
  t.is(deriveResearchDocumentTitle("a   spaced  title"), "a spaced title");
  const long = deriveResearchDocumentTitle(`# ${"x".repeat(80)}`);
  t.is([...long].length, 73);
  t.true(long.endsWith("…"));
  t.is(deriveResearchDocumentTitle("x".repeat(RESEARCH_DOCUMENT_BYTE_LIMIT)), `${"x".repeat(72)}…`);
});

test("imported citation handles are hidden and ordinary links are kept", (t) => {
  t.is(
    stripImportedReportCitations("A claim \uE200cite\uE202turn0search1\uE201 and more."),
    "A claim and more.",
  );
  t.is(
    stripImportedReportCitations("See [source](https://example.com)."),
    "See [source](https://example.com).",
  );
  // An incomplete token is left exactly as written.
  t.is(
    stripImportedReportCitations("A claim \uE200cite\uE202turn0"),
    "A claim \uE200cite\uE202turn0",
  );
});
