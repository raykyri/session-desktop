import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { researchColumnWidths } from "../src/lib/researchColumnWidths";
import { ResearchPairHeader, ResearchThreadPlaceholder } from "../src/components/research/ResearchColumnChrome";

test("columns are sized from the strip's width: feed 21%, messages 18%, answer 44%, each clamped", () => {
  // The strip at 1440px with the full sidebar, and at 1100px.
  assert.deepEqual(researchColumnWidths(1198), { feed: 252, messages: 220, answer: 527 });
  assert.deepEqual(researchColumnWidths(858), { feed: 240, messages: 220, answer: 378 });
  // Wide strips stop at the maximums; narrow ones keep the minimums and scroll.
  assert.deepEqual(researchColumnWidths(2400), { feed: 300, messages: 280, answer: 660 });
  assert.deepEqual(researchColumnWidths(500), { feed: 240, messages: 220, answer: 340 });
});

test("invalid widths fall back to the minimums", () => {
  assert.deepEqual(researchColumnWidths(NaN), { feed: 240, messages: 220, answer: 340 });
  assert.deepEqual(researchColumnWidths(-Infinity), { feed: 240, messages: 220, answer: 340 });
});

const noop = () => {};
const header = (props: Partial<Parameters<typeof ResearchPairHeader>[0]> = {}) =>
  renderToStaticMarkup(createElement(ResearchPairHeader, { title: "A thread", ...props }));

test("a pair's header is one drag-region bar with the title, and no + Ask, Answer label or counter", () => {
  const html = header();
  assert.match(html, /class="research-column-bar" data-tauri-drag-region="true"/);
  assert.match(html, /<h2 class="research-column-title"[^>]*title="A thread">A thread<\/h2>/);
  assert.doesNotMatch(html, /Go to the ask box|<button/);
  assert.doesNotMatch(html, />Answer</);
  assert.doesNotMatch(html, / of \d/);
});

test("branch headers show Branch with a message count or New branch", () => {
  assert.match(header({ branch: 2 }), /Branch<span class="research-column-count"> · 2 messages<\/span>/);
  assert.match(header({ branch: 1 }), / · 1 message</);
  assert.match(header({ branch: "new" }), /New branch<\/h2>/);
});

test("only the root conversation header shows back and forward controls", () => {
  const history = {
    canGoBack: true,
    canGoForward: false,
    backTitle: "Back (⌘[)",
    forwardTitle: "Forward (⌘])",
    onBack: noop,
    onForward: noop,
  };
  const html = header({ history });
  assert.match(html, /<div class="research-history-nav" role="group" aria-label="Research history">/);
  assert.equal(html.match(/aria-label="Back"/g)?.length, 1);
  assert.doesNotMatch(header({ branch: 1 }), /research-history-nav/);
});

test("a loading thread header preserves the back and forward controls", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(ResearchThreadPlaceholder, {
      title: "Note",
      children: createElement("p", null, "Loading research…"),
      history: {
        canGoBack: true,
        canGoForward: false,
        backTitle: "Back",
        forwardTitle: "Forward",
        onBack: noop,
        onForward: noop,
      },
    }),
  );
  assert.ok(html.indexOf('aria-label="Research history"') < html.indexOf(">Note</h2>"));
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /disabled=""[^>]*aria-label="Forward"/);
});

