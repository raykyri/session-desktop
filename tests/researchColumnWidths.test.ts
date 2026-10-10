import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchColumns from "../src/components/research/ResearchColumns";
import {
  ResearchColumnResizer,
  ResearchColumnSizingContext,
  type ResearchColumnSizing,
} from "../src/components/research/ResearchColumnResizer";
import {
  RESEARCH_COLUMN_WIDTH_KEYS,
  loadResearchColumnWidths,
  parseStoredColumnWidth,
  researchColumnResize,
  researchColumnWidthBounds,
  researchColumnWidthKind,
  researchStripSlack,
  saveResearchColumnWidth,
  shownResearchColumnWidths,
} from "../src/lib/researchColumnWidths";

test("a stored width is a positive number of pixels", () => {
  assert.equal(parseStoredColumnWidth("320"), 320);
  assert.equal(parseStoredColumnWidth("412.5"), 412.5);
  for (const value of [null, "", "  ", "0", "-40", "wide", "NaN", "Infinity"]) {
    assert.equal(parseStoredColumnWidth(value), null, String(value));
  }
});

test("each kind's range: the feed's maximum follows the strip, the pair columns' are fixed", () => {
  assert.deepEqual(researchColumnWidthBounds("feed", 1400), { min: 240, max: 560 });
  assert.deepEqual(researchColumnWidthBounds("feed", 800), { min: 240, max: 400 });
  assert.deepEqual(researchColumnWidthBounds("feed", 300), { min: 240, max: 240 });
  assert.deepEqual(researchColumnWidthBounds("turns", 300), { min: 220, max: 560 });
  assert.deepEqual(researchColumnWidthBounds("answer", 3000), { min: 340, max: 960 });
});

test("set widths replace the automatic ones, clamped to their ranges", () => {
  // Automatic at 1198px: feed 252, messages 220, answer 527.
  assert.deepEqual(shownResearchColumnWidths({ feed: null, turns: null, answer: null }, 1198), {
    feed: 252,
    turns: 220,
    answer: 527,
  });
  assert.deepEqual(shownResearchColumnWidths({ feed: 300, turns: 400.4, answer: 700 }, 1198), {
    feed: 300,
    turns: 400,
    answer: 700,
  });
  assert.deepEqual(shownResearchColumnWidths({ feed: 900, turns: 100, answer: 5000 }, 1198), {
    feed: 560,
    turns: 220,
    answer: 960,
  });
});

test("widths load from and save to their own storage keys", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const global = globalThis as { localStorage?: unknown };
  const previous = global.localStorage;
  global.localStorage = storage;
  try {
    assert.deepEqual(loadResearchColumnWidths(), { feed: null, turns: null, answer: null });
    saveResearchColumnWidth("turns", 301.6);
    saveResearchColumnWidth("answer", 720);
    store.set(RESEARCH_COLUMN_WIDTH_KEYS.feed, "garbage");
    assert.equal(store.get("session.research.turnsWidth"), "302");
    assert.equal(store.get("session.research.answerWidth"), "720");
    assert.deepEqual(loadResearchColumnWidths(), { feed: null, turns: 302, answer: 720 });
    saveResearchColumnWidth("answer", null);
    assert.equal(store.has("session.research.answerWidth"), false);
  } finally {
    global.localStorage = previous;
  }
  // Without storage, every width is automatic and saving does nothing.
  assert.deepEqual(loadResearchColumnWidths(), { feed: null, turns: null, answer: null });
  assert.doesNotThrow(() => saveResearchColumnWidth("turns", 300));
});

test("columns share a width by kind: messages-side columns, and answer, post and editor columns", () => {
  assert.equal(researchColumnWidthKind("turns"), "turns");
  assert.equal(researchColumnWidthKind("answer"), "answer");
  assert.equal(researchColumnWidthKind("post"), "answer");
  assert.equal(researchColumnWidthKind("editor"), "answer");
  assert.equal(researchColumnWidthKind(undefined), null);
});

test("a resize follows the pointer and scrolls the strip by the change of the same-kind columns before it", () => {
  const base = { startWidth: 300, startScrollLeft: 500, min: 220, max: 560 };
  // The first level's column: nothing before it changes width.
  assert.deepEqual(researchColumnResize({ ...base, delta: 40, sharedBefore: 0 }), { width: 340, scrollLeft: 500 });
  // The third level's column: the two before it widen too.
  assert.deepEqual(researchColumnResize({ ...base, delta: 40, sharedBefore: 2 }), { width: 340, scrollLeft: 580 });
  assert.deepEqual(researchColumnResize({ ...base, delta: -60, sharedBefore: 2 }), { width: 240, scrollLeft: 380 });
  // Clamped: the scroll offset follows the clamped width.
  assert.deepEqual(researchColumnResize({ ...base, delta: 400, sharedBefore: 1 }), { width: 560, scrollLeft: 760 });
  assert.deepEqual(researchColumnResize({ ...base, delta: -400, sharedBefore: 0 }), { width: 220, scrollLeft: 500 });
});

test("when the strip can't scroll back far enough, the column's left edge moves and the handle stays under the pointer", () => {
  // Scrolled 20px, one same-kind column before: shrinking by 80px would need
  // -60px of scroll. The width w satisfies (w - 300) * 2 = -80 - 20.
  const result = researchColumnResize({
    startWidth: 300,
    delta: -80,
    startScrollLeft: 20,
    sharedBefore: 1,
    min: 220,
    max: 560,
  });
  assert.deepEqual(result, { width: 250, scrollLeft: 0 });
  // Handle position relative to the start: the edge moved by min(0, 20 + (250 - 300)) = -30, the width by -50.
  assert.equal(Math.min(0, 20 + (result.width - 300)) + (result.width - 300), -80);
});

test("the strip keeps trailing space only while its view reaches past the last column", () => {
  assert.equal(researchStripSlack(500, 1000, 1600), 0);
  assert.equal(researchStripSlack(700, 1000, 1600), 100);
  // Content narrower than the view: at offset 0 the filler fills the view;
  // scrolled, the space covers the rest of the view.
  assert.equal(researchStripSlack(0, 1000, 600), 0);
  assert.equal(researchStripSlack(120, 1000, 600), 520);
});

const sizing: ResearchColumnSizing = {
  row: null,
  widths: { feed: 260, turns: 300, answer: 640 },
  automatic: { feed: 252, turns: 220, answer: 527 },
  bounds: {
    feed: { min: 240, max: 560 },
    turns: { min: 220, max: 560 },
    answer: { min: 340, max: 960 },
  },
  setWidth: () => {},
};

const resizer = (props: Parameters<typeof ResearchColumnResizer>[0]) =>
  renderToStaticMarkup(
    createElement(ResearchColumnSizingContext.Provider, { value: sizing }, createElement(ResearchColumnResizer, props)),
  );

test("a pair column's handle is a focusable vertical separator with its kind's range and width", () => {
  const turns = resizer({ kind: "turns", label: "Resize messages column", belowHeader: true });
  assert.match(turns, /^<div class="research-column-resizer is-below-header" role="separator"/);
  assert.match(turns, /aria-label="Resize messages column"/);
  assert.match(turns, /aria-orientation="vertical"/);
  assert.match(turns, /aria-valuemin="220" aria-valuemax="560" aria-valuenow="300"/);
  assert.match(turns, /tabindex="0"/);
  const answer = resizer({ kind: "answer", label: "Resize answer column" });
  assert.match(answer, /^<div class="research-column-resizer" role="separator"/);
  assert.match(answer, /aria-valuemin="340" aria-valuemax="960" aria-valuenow="640"/);
});

test("a handle outside the column area renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(ResearchColumnResizer, { kind: "turns", label: "Resize" })), "");
});

test("the feed column carries its handle, and the strip sets the three width properties", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchColumns, { hasDocument: false, feed: createElement("p", null, "Feed"), children: null }),
  );
  assert.match(html, /--research-feed-column-width:\d+px;--research-turns-width:\d+px;--research-answer-width:\d+px/);
  assert.match(
    html,
    /<div class="research-column-resizer" role="separator" aria-label="Resize feed" aria-orientation="vertical" aria-valuemin="240" aria-valuemax="\d+" aria-valuenow="\d+"/,
  );
});
