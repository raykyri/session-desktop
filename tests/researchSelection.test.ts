import assert from "node:assert/strict";
import test from "node:test";
import {
  clipResearchSelectionToParagraph,
  isLiveResearchSelection,
  researchSelectionActionPlacement,
  snapResearchDragSelection,
} from "../src/lib/researchSelection";

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

test("centres selection actions 8px above the selected passage", () => {
  assert.deepEqual(
    researchSelectionActionPlacement({
      boundingRect: rect(80, 240, 400, 48),
      viewportWidth: 1200,
      viewportHeight: 800,
      width: 260,
      height: 36,
    }),
    { left: 150, top: 196, offscreen: false },
  );
});

test("drops selection actions below the passage when there is no room above it", () => {
  assert.deepEqual(
    researchSelectionActionPlacement({
      boundingRect: rect(1000, 70, 180, 24),
      viewportWidth: 1200,
      viewportHeight: 800,
      width: 260,
      height: 36,
    }),
    { left: 932, top: 102, offscreen: false },
  );
  assert.equal(
    researchSelectionActionPlacement({
      boundingRect: rect(80, 900, 100, 20),
      viewportWidth: 1200,
      viewportHeight: 800,
      width: 260,
      height: 36,
    }).offscreen,
    true,
  );
});

test("snaps forward and backward drags to whole words", () => {
  const text = "The quick, brown fox.";
  assert.deepEqual(snapResearchDragSelection(text, 6, 13), {
    start: 4,
    end: 16,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection(text, 13, 6), {
    start: 4,
    end: 16,
    direction: "backward",
  });
});

test("keeps the anchor word selected while a drag reverses inside it", () => {
  const text = "The quick brown fox";
  assert.deepEqual(snapResearchDragSelection(text, 7, 5), {
    start: 4,
    end: 9,
    direction: "backward",
  });
  assert.deepEqual(snapResearchDragSelection(text, 7, 7), {
    start: 4,
    end: 9,
    direction: "forward",
  });
});

test("excludes outer whitespace and includes attached punctuation", () => {
  const text = "The quick, brown fox.";
  assert.deepEqual(snapResearchDragSelection(text, 5, 10), {
    start: 4,
    end: 10,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection(text, 5, 20), {
    start: 4,
    end: 21,
    direction: "forward",
  });
});

test("includes quotation marks and punctuation surrounding a dragged passage", () => {
  const quoted = "She called it “surprisingly robust.” Then left.";
  const quoteStart = quoted.indexOf("“");
  const quoteEnd = quoted.indexOf("”") + 1;
  assert.deepEqual(
    snapResearchDragSelection(quoted, quoteStart + 2, quoteEnd - 2),
    { start: quoteStart, end: quoteEnd, direction: "forward" },
  );
  assert.deepEqual(
    snapResearchDragSelection(quoted, quoteEnd - 2, quoteStart + 2),
    { start: quoteStart, end: quoteEnd, direction: "backward" },
  );

  const parenthesized = "Choose (alpha + beta), then stop.";
  const passageStart = parenthesized.indexOf("(");
  const passageEnd = parenthesized.indexOf(",") + 1;
  assert.deepEqual(
    snapResearchDragSelection(parenthesized, passageStart + 2, passageEnd - 3),
    { start: passageStart, end: passageEnd, direction: "forward" },
  );
});

test("follows locale-aware boundaries for contractions, hyphens, and CJK", () => {
  assert.deepEqual(snapResearchDragSelection("don't stop", 2, 2), {
    start: 0,
    end: 5,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection("state-of-the-art", 1, 10), {
    start: 0,
    end: 12,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection("你好世界", 1, 3), {
    start: 0,
    end: 4,
    direction: "forward",
  });
});

test("treats composed emoji as indivisible selectable units", () => {
  const text = "go 👩‍💻 now";
  assert.deepEqual(snapResearchDragSelection(text, 4, 4), {
    start: 3,
    end: 8,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection("e\u0301lan", 2, 2), {
    start: 0,
    end: 5,
    direction: "forward",
  });
});

test("never snaps across a message seam", () => {
  // The projection carries no separator between messages, so without the seam
  // segmentation fuses this turn's last word with the next turn's first.
  const turn = "Make it faster";
  const text = `${turn}I rewrote the loop`;
  assert.deepEqual(snapResearchDragSelection(text, 8, turn.length), {
    start: 8,
    end: turn.length + 1,
    direction: "forward",
  });
  assert.deepEqual(
    snapResearchDragSelection(text, 8, turn.length, undefined, [turn.length]),
    { start: 8, end: turn.length, direction: "forward" },
  );
  // A period between letters does not break a word either, so a turn ending in
  // one fuses just the same.
  const punctuated = "Make it faster.";
  const punctuatedText = `${punctuated}I rewrote the loop`;
  assert.deepEqual(snapResearchDragSelection(punctuatedText, 8, punctuated.length), {
    start: 8,
    end: punctuated.length + 1,
    direction: "forward",
  });
  assert.deepEqual(
    snapResearchDragSelection(punctuatedText, 8, punctuated.length, undefined, [
      punctuated.length,
    ]),
    { start: 8, end: punctuated.length, direction: "forward" },
  );
  // Dragging back from inside the next turn stays inside it: the seam ends the
  // leading unit at the turn's first character rather than the previous turn's
  // last word.
  assert.deepEqual(
    snapResearchDragSelection(text, turn.length + 3, turn.length, undefined, [
      turn.length,
    ]),
    { start: turn.length, end: turn.length + 9, direction: "backward" },
  );
  // A drag that genuinely spans two messages still snaps on both outer edges;
  // the seam only stops snapping from creating the crossing.
  assert.deepEqual(
    snapResearchDragSelection(text, 10, turn.length + 3, undefined, [turn.length]),
    { start: 8, end: turn.length + 9, direction: "forward" },
  );
});

test("rejects invalid offsets", () => {
  assert.equal(snapResearchDragSelection("answer", -1, 2), null);
  assert.equal(snapResearchDragSelection("answer", 1, 99), null);
});

test("falls back cleanly when the locale cannot be segmented", () => {
  assert.equal(snapResearchDragSelection("answer", 1, 2, "not_a_locale"), null);
});

test("a selection that runs into the next paragraph is cut at the end of the first", () => {
  const projection = "First paragraph text.  \nSecond paragraph.";
  const paragraphEnd = projection.indexOf("\n");
  // From "paragraph text." into "Second": cut before the trailing spaces.
  assert.deepEqual(clipResearchSelectionToParagraph(projection, { start: 6, end: 30 }, paragraphEnd), {
    start: 6,
    end: 21,
    crossed: true,
  });
  // Within one paragraph (no end given), or ending inside the first one: unchanged.
  assert.deepEqual(clipResearchSelectionToParagraph(projection, { start: 6, end: 15 }, null), {
    start: 6,
    end: 15,
    crossed: false,
  });
  assert.deepEqual(clipResearchSelectionToParagraph(projection, { start: 6, end: 15 }, paragraphEnd), {
    start: 6,
    end: 15,
    crossed: false,
  });
  // Starting in the first paragraph's trailing whitespace: the cut would
  // keep nothing, so the selection stays whole.
  assert.deepEqual(clipResearchSelectionToParagraph(projection, { start: 21, end: 30 }, paragraphEnd), {
    start: 21,
    end: 30,
    crossed: false,
  });
});

test("only a selection in a streaming answer without a revision is live", () => {
  assert.equal(isLiveResearchSelection("", "running"), true);
  assert.equal(isLiveResearchSelection("", "queued"), true);
  assert.equal(isLiveResearchSelection("rev-1", "running"), false);
  assert.equal(isLiveResearchSelection("", "complete"), false);
  assert.equal(isLiveResearchSelection("", undefined), false);
});
