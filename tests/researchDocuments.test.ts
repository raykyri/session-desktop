import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DocumentComposer from "../src/components/research/DocumentComposer";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  ResearchDocumentWordLimitExceeded,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
  researchDocumentEditGate,
} from "../src/lib/researchDocuments";

test("word counting matches whitespace-delimited tokens", () => {
  assert.equal(countResearchDocumentWords(""), 0);
  assert.equal(countResearchDocumentWords("   \n\t"), 0);
  assert.equal(countResearchDocumentWords("one"), 1);
  assert.equal(countResearchDocumentWords("# Heading\n\nTwo  words\there\n"), 5);
  assert.equal(
    countResearchDocumentWords(Array(RESEARCH_DOCUMENT_WORD_LIMIT).fill("w").join(" ")),
    RESEARCH_DOCUMENT_WORD_LIMIT,
  );
});

test("limited word counting stops at the first word over the limit", () => {
  const markdown = Array(RESEARCH_DOCUMENT_WORD_LIMIT + 100).fill("w").join(" ");
  assert.throws(
    () => countResearchDocumentWords(markdown, RESEARCH_DOCUMENT_WORD_LIMIT),
    (error) => {
      assert.ok(error instanceof ResearchDocumentWordLimitExceeded);
      assert.equal(error.limit, RESEARCH_DOCUMENT_WORD_LIMIT);
      assert.equal(error.count, RESEARCH_DOCUMENT_WORD_LIMIT + 1);
      return true;
    },
  );
});

test("word counting agrees with Rust split_whitespace on the code points JS \\s gets wrong", () => {
  // U+0085 NEL is Unicode White_Space (a separator to the backend) but not
  // JS \s; U+FEFF is JS \s but not White_Space. Pinned against the matching
  // backend test in src-tauri/src/research.rs.
  assert.equal(countResearchDocumentWords("a\u0085b"), 2);
  assert.equal(countResearchDocumentWords("a\uFEFFb"), 1);
  assert.equal(countResearchDocumentWords("a\u1680\u2007\u2028\u202F\u205F\u3000b"), 2);
});

test("derived titles prefer the first content line and strip heading markers", () => {
  assert.equal(deriveResearchDocumentTitle("\n\n## Quarterly Report\n\nBody"), "Quarterly Report");
  assert.equal(deriveResearchDocumentTitle("plain first line\nsecond"), "plain first line");
  // A heading-marker-only line has no content; the next line wins.
  assert.equal(deriveResearchDocumentTitle("#\nReal title"), "Real title");
  assert.equal(deriveResearchDocumentTitle("  \n\t"), "Untitled document");
});

test("derived titles use backend White_Space rules for U+FEFF and U+0085", () => {
  // U+FEFF is JS whitespace but NOT Unicode White_Space: like the backend, the
  // BOM must stay before the heading marker, so the marker is not stripped and
  // the preview matches the persisted "# Title"-equivalent title.
  assert.equal(deriveResearchDocumentTitle("\uFEFF# Title"), "\uFEFF# Title");
  // U+0085 (NEL) is Unicode White_Space but NOT JS \s: it must trim away so the
  // heading marker is recognized, matching the backend.
  assert.equal(deriveResearchDocumentTitle("\u0085Real title"), "Real title");
});

test("derived titles normalize whitespace and truncate like backend titles", () => {
  assert.equal(deriveResearchDocumentTitle("a   spaced  title"), "a spaced title");
  const long = deriveResearchDocumentTitle(`# ${"x".repeat(80)}`);
  assert.equal([...long].length, 73);
  assert.ok(long.endsWith("…"));
  assert.equal(
    deriveResearchDocumentTitle("x".repeat(RESEARCH_DOCUMENT_BYTE_LIMIT)),
    `${"x".repeat(72)}…`,
  );
});

test("document size limits apply when the body changes", () => {
  const long = Array(RESEARCH_DOCUMENT_WORD_LIMIT + 1).fill("w").join(" ");
  const base = {
    markdown: long,
    initialMarkdown: long,
    title: "Report",
    initialTitle: "Report",
    overWordLimit: true,
    overByteLimit: false,
  };
  const unchanged = researchDocumentEditGate(base);
  assert.equal(unchanged.canSave, false);
  assert.match(unchanged.limitNotice ?? "", /only the title can be changed/);

  const renamed = researchDocumentEditGate({ ...base, title: "Renamed" });
  assert.equal(renamed.canSave, true);
  assert.match(renamed.limitNotice ?? "", /10,000-word limit/);

  const edited = researchDocumentEditGate({ ...base, markdown: `${long} more`, title: "Renamed" });
  assert.equal(edited.canSave, false);
  assert.match(edited.limitNotice ?? "", /Shorten it to 10,000 words or fewer to save/);

  const withinLimit = researchDocumentEditGate({
    ...base,
    markdown: "Short",
    initialMarkdown: "Old",
    overWordLimit: false,
  });
  assert.deepEqual(withinLimit, { canSave: true, limitNotice: null });
  assert.equal(
    researchDocumentEditGate({ ...base, markdown: "  ", overWordLimit: false }).canSave,
    false,
  );
  assert.equal(
    researchDocumentEditGate({ ...base, markdown: "x", overWordLimit: false, overByteLimit: true })
      .limitNotice,
    "The content is over the 10 MB limit. Shorten it to 10 MB or less to save.",
  );
});

test("the edit dialog says when a document is over the word limit", () => {
  const long = Array(RESEARCH_DOCUMENT_WORD_LIMIT + 1).fill("w").join(" ");
  const html = renderToStaticMarkup(
    createElement(DocumentComposer, {
      initialMarkdown: long,
      initialTitle: "Report",
      onClose: () => {},
      onSubmit: async () => {},
    }),
  );
  assert.match(html, /only the title can be changed/);
  assert.match(html, /Over 10,000 words/);
});
