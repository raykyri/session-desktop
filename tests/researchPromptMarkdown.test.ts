import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchSegmentPrompt } from "../src/components/research/ResearchDocument";

test("research prompts preserve Markdown blockquotes", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      visible: true,
      index: 0,
      parentNodeId: null,
      queryQuote: null,
      prompt: "> foo\n> bar",
      adapter: "claude",
      model: "fable",
      onSelectNode: () => {},
    }),
  );

  assert.match(html, /You asked Claude Fable/);
  assert.ok(html.indexOf("You asked Claude Fable") < html.indexOf("<blockquote>"));
  assert.match(html, /<blockquote>/);
  assert.match(html, /foo<br\/>[\n]?bar/);
});
