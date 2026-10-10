import assert from "node:assert/strict";
import test from "node:test";
import { countUnmatchedResearchAnchors, reanchorResearchQuote } from "../src/lib/researchAnchors";

// The cases below are repeated in src-tauri/src/research_anchors.rs.

function anchor(exact: string, prefix: string, suffix: string, start: number) {
  return { exact, prefix, suffix, start, end: start + exact.length };
}

test("a quote in an unchanged paragraph moves with the text before it", () => {
  const old = "# Report\n\nThe sky is blue.\n\nGrass is green.";
  const next = "# Report\n\nAn added paragraph.\n\nThe sky is blue.\n\nGrass is green.";
  assert.deepEqual(reanchorResearchQuote(anchor("Grass is green", "The sky is blue.\n", ".", 24), old, next), {
    kind: "moved",
    start: 45,
    end: 59,
  });
});

test("Markdown syntax around a rendered quote does not prevent a match", () => {
  const old = "Revenue grew **12%** in Q3.\n\n- First item";
  const next = "Revenue grew **12%** in Q3 and Q4.\n\n- First item";
  assert.deepEqual(reanchorResearchQuote(anchor("Revenue grew 12%", "", " in Q3.\nFirst", 0), old, next), {
    kind: "moved",
    start: 0,
    end: 16,
  });
});

test("a removed quote no longer matches", () => {
  assert.deepEqual(
    reanchorResearchQuote(
      anchor("Drop this sentence", "Keep this.\n", ".", 11),
      "Keep this.\n\nDrop this sentence.",
      "Keep this.",
    ),
    { kind: "unmatched" },
  );
});

test("context chooses between repeated quotes", () => {
  const old = "Alpha: the result.\n\nBeta: the result.";
  const next = "Beta: the result.\n\nAlpha: the result.\n\nGamma: the result.";
  assert.deepEqual(reanchorResearchQuote(anchor("the result", "Beta: ", ".", 26), old, next), {
    kind: "moved",
    start: 6,
    end: 16,
  });
});

test("a repeated quote whose context changed on both sides no longer matches", () => {
  const old = "One the result two.\n\nThree the result four.";
  const next = "Five the result six.\n\nSeven the result eight.";
  assert.deepEqual(reanchorResearchQuote(anchor("the result", "One ", " two", 4), old, next), { kind: "unmatched" });
});

test("a single occurrence that keeps one side still matches", () => {
  assert.deepEqual(
    reanchorResearchQuote(
      anchor("the passage", "Before ", " after.", 7),
      "Before the passage after.",
      "Changed the passage after.",
    ),
    { kind: "moved", start: 8, end: 19 },
  );
});

test("a quote not found in the old text is left unchanged", () => {
  const old = "Rendered math: $x^2$.";
  assert.deepEqual(reanchorResearchQuote(anchor("x²", "", "", 15), old, "Something else."), { kind: "unchanged" });
  assert.deepEqual(reanchorResearchQuote(anchor("—", "", "", 0), old, "Something else."), { kind: "unchanged" });
});

test("offsets count UTF-16 units", () => {
  assert.deepEqual(
    reanchorResearchQuote(anchor("smile", "", " here", 3), "😀 smile here.", "😀😀 smile here."),
    { kind: "moved", start: 5, end: 10 },
  );
});

test("the editor counts the highlights an edit removes", () => {
  const old = "First point.\n\nSecond point.";
  const anchors = [anchor("First point", "", ".", 0), anchor("Second point", "First point.\n", ".", 13)];
  assert.equal(countUnmatchedResearchAnchors(anchors, old, "First point, revised."), 1);
  assert.equal(countUnmatchedResearchAnchors(anchors, old, old), 0);
  assert.equal(countUnmatchedResearchAnchors([], old, ""), 0);
});
