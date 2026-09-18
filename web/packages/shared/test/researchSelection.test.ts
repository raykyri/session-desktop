import test from "ava";

import {
  researchAnchorConnectorEndpoints,
  researchSelectionActionPlacement,
  shouldDismissEmptyResearchAskOnClick,
  snapResearchDragSelection,
} from "../src/research/selection.js";

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

test("uses a horizontal connector when the passage midpoint is inside the card", (t) => {
  t.deepEqual(
    researchAnchorConnectorEndpoints({
      selectionRect: rect(100, 140, 900, 160),
      cardRect: rect(1100, 120, 320, 240),
    }),
    { sx: 1008, sy: 220, ex: 1094, ey: 220 },
  );
});

test("uses a direct diagonal to the card's safe inset when the midpoint is outside", (t) => {
  t.deepEqual(
    researchAnchorConnectorEndpoints({
      selectionRect: rect(100, 40, 600, 40),
      cardRect: rect(800, 120, 320, 160),
    }),
    { sx: 708, sy: 60, ex: 794, ey: 144 },
  );
});

test("places selection actions beside the final line of a multi-line selection", (t) => {
  t.deepEqual(
    researchSelectionActionPlacement({
      fragments: [rect(80, 40, 900, 24), rect(80, 64, 230, 24)],
      boundingRect: rect(80, 40, 900, 48),
      viewportWidth: 1200,
      viewportHeight: 800,
      reservedWidth: 260,
    }),
    { left: 314, top: 58.5, offscreen: false },
  );
});

test("drops selection actions below the final line when they do not fit beside it", (t) => {
  t.deepEqual(
    researchSelectionActionPlacement({
      fragments: [rect(80, 40, 900, 24), rect(900, 64, 230, 24)],
      boundingRect: rect(80, 40, 1050, 48),
      viewportWidth: 1200,
      viewportHeight: 800,
      reservedWidth: 260,
    }),
    { left: 870, top: 92, offscreen: false },
  );
});

test("dismisses an empty targeted ask only when a click clears the selection", (t) => {
  const base = {
    followup: "",
    selectionCollapsed: true,
    insideComposer: false,
    insideSelectionActions: false,
  };
  t.is(shouldDismissEmptyResearchAskOnClick(base), true);
  t.is(shouldDismissEmptyResearchAskOnClick({ ...base, selectionCollapsed: false }), false);
  t.is(shouldDismissEmptyResearchAskOnClick({ ...base, insideComposer: true }), false);
  t.is(shouldDismissEmptyResearchAskOnClick({ ...base, insideSelectionActions: true }), false);
});

test("preserves targeted asks containing text", (t) => {
  const base = {
    selectionCollapsed: true,
    insideComposer: false,
    insideSelectionActions: false,
  };
  t.is(shouldDismissEmptyResearchAskOnClick({ ...base, followup: "question" }), false);
  t.is(shouldDismissEmptyResearchAskOnClick({ ...base, followup: "  \n" }), true);
});

test("snaps forward and backward drags to whole words", (t) => {
  const text = "The quick, brown fox.";
  t.deepEqual(snapResearchDragSelection(text, 6, 13), {
    start: 4,
    end: 16,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection(text, 13, 6), {
    start: 4,
    end: 16,
    direction: "backward",
  });
});

test("keeps the anchor word selected while a drag reverses inside it", (t) => {
  const text = "The quick brown fox";
  t.deepEqual(snapResearchDragSelection(text, 7, 5), {
    start: 4,
    end: 9,
    direction: "backward",
  });
  t.deepEqual(snapResearchDragSelection(text, 7, 7), {
    start: 4,
    end: 9,
    direction: "forward",
  });
});

test("excludes outer whitespace and includes attached punctuation", (t) => {
  const text = "The quick, brown fox.";
  t.deepEqual(snapResearchDragSelection(text, 5, 10), {
    start: 4,
    end: 10,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection(text, 5, 20), {
    start: 4,
    end: 21,
    direction: "forward",
  });
});

test("includes quotation marks and punctuation surrounding a dragged passage", (t) => {
  const quoted = "She called it “surprisingly robust.” Then left.";
  const quoteStart = quoted.indexOf("“");
  const quoteEnd = quoted.indexOf("”") + 1;
  t.deepEqual(snapResearchDragSelection(quoted, quoteStart + 2, quoteEnd - 2), {
    start: quoteStart,
    end: quoteEnd,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection(quoted, quoteEnd - 2, quoteStart + 2), {
    start: quoteStart,
    end: quoteEnd,
    direction: "backward",
  });

  const parenthesized = "Choose (alpha + beta), then stop.";
  const passageStart = parenthesized.indexOf("(");
  const passageEnd = parenthesized.indexOf(",") + 1;
  t.deepEqual(snapResearchDragSelection(parenthesized, passageStart + 2, passageEnd - 3), {
    start: passageStart,
    end: passageEnd,
    direction: "forward",
  });
});

test("follows locale-aware boundaries for contractions, hyphens, and CJK", (t) => {
  t.deepEqual(snapResearchDragSelection("don't stop", 2, 2), {
    start: 0,
    end: 5,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection("state-of-the-art", 1, 10), {
    start: 0,
    end: 12,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection("你好世界", 1, 3), {
    start: 0,
    end: 4,
    direction: "forward",
  });
});

test("treats composed emoji as indivisible selectable units", (t) => {
  const text = "go 👩‍💻 now";
  t.deepEqual(snapResearchDragSelection(text, 4, 4), {
    start: 3,
    end: 8,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection("e\u0301lan", 2, 2), {
    start: 0,
    end: 5,
    direction: "forward",
  });
});

test("never snaps across a message seam", (t) => {
  // The projection carries no separator between messages, so without the seam
  // segmentation fuses this message's last word with the next one's first.
  const message = "Make it faster";
  const text = `${message}I rewrote the loop`;
  t.deepEqual(snapResearchDragSelection(text, 8, message.length), {
    start: 8,
    end: message.length + 1,
    direction: "forward",
  });
  t.deepEqual(snapResearchDragSelection(text, 8, message.length, undefined, [message.length]), {
    start: 8,
    end: message.length,
    direction: "forward",
  });
  // A period between letters does not break a word either, so a message ending
  // in one fuses just the same.
  const punctuated = "Make it faster.";
  const punctuatedText = `${punctuated}I rewrote the loop`;
  t.deepEqual(snapResearchDragSelection(punctuatedText, 8, punctuated.length), {
    start: 8,
    end: punctuated.length + 1,
    direction: "forward",
  });
  t.deepEqual(
    snapResearchDragSelection(punctuatedText, 8, punctuated.length, undefined, [punctuated.length]),
    { start: 8, end: punctuated.length, direction: "forward" },
  );
  // Dragging back from inside the next message stays inside it: the seam ends
  // the leading unit at the message's first character rather than the previous
  // message's last word.
  t.deepEqual(
    snapResearchDragSelection(text, message.length + 3, message.length, undefined, [
      message.length,
    ]),
    { start: message.length, end: message.length + 9, direction: "backward" },
  );
  // A drag that genuinely spans two messages still snaps on both outer edges;
  // the seam only stops snapping from creating the crossing.
  t.deepEqual(
    snapResearchDragSelection(text, 10, message.length + 3, undefined, [message.length]),
    {
      start: 8,
      end: message.length + 9,
      direction: "forward",
    },
  );
});

test("rejects invalid offsets", (t) => {
  t.is(snapResearchDragSelection("answer", -1, 2), null);
  t.is(snapResearchDragSelection("answer", 1, 99), null);
});

test("falls back cleanly when the locale cannot be segmented", (t) => {
  t.is(snapResearchDragSelection("answer", 1, 2, "not_a_locale"), null);
});
