import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TranscriptMarkdown, { transcriptMathPluginsReady } from "../src/components/TranscriptMarkdown";
import {
  enclosingMessageFlatBounds,
  flatTextOffsetAt,
  rangeForTextOffsets,
  researchTextProjection,
  selectionOffsets,
  selectionTouchesNonTextRow,
} from "../src/components/research/researchTextRanges";
import { resolveResearchHighlightOffset } from "@session/shared/lib/researchHighlights";
import type { ResearchHighlight } from "../src/types";
import { withWidgetDom } from "./widgetDom";

await transcriptMathPluginsReady;

test("highlight and branch projections and DOM ranges survive widget display toggles", async () => {
  await withWidgetDom(async () => {
    const markdown = "Prior prose.\n\n```session-html\n<p>First widget</p>\n```\n\nTarget.\n\n```session-html\n<p>Second widget</p>\n```\n\nNext prose.";
    let anchor: ResearchHighlight | null = null;
    let expected = "";
    for (const widgets of [true, false, true]) {
      document.body.innerHTML = `<div class="research-response-message">${renderToStaticMarkup(createElement(TranscriptMarkdown, { text: markdown, widgets }))}</div>`;
      const root = document.body;
      const projection = researchTextProjection(root);
      const start = projection.indexOf("Target.");
      const end = start + "Target.".length;
      if (!anchor) {
        expected = projection;
        anchor = { id: "highlight", createdAt: 0, anchor: {
          version: 1, projection: "answer-v1", responseRevision: "same",
          start, end, exact: "Target.", prefix: projection.slice(0, start), suffix: projection.slice(end),
        } };
      }
      assert.equal(projection, expected);
      assert.deepEqual(resolveResearchHighlightOffset(projection, "same", anchor), { start, end });
      const range = rangeForTextOffsets(root, start, end)!;
      assert.equal(range.toString(), "Target.");
      assert.deepEqual(selectionOffsets(root, range), { start, end });
      assert.equal(selectionTouchesNonTextRow(root, range), false);
      const paragraph = range.startContainer.parentElement!;
      assert.equal(flatTextOffsetAt(root, paragraph, 0), start);
      assert.equal(flatTextOffsetAt(root, paragraph, paragraph.childNodes.length), end);
      assert.deepEqual(enclosingMessageFlatBounds(root, range), { start: 0, end: projection.length });
      if (!widgets) {
        assert.ok(root.textContent!.includes("First widget"), "source is still visible and copyable");
        const source = root.querySelector("code")!.firstChild!;
        assert.equal(flatTextOffsetAt(root, source, 0), null, "widget source cannot become an anchor");
      }
    }
  });
});

test("a projected range starting after a widget does not include its source", async () => {
  await withWidgetDom(async () => {
    document.body.innerHTML = '<p>Before</p><div data-research-widget><pre>source</pre></div><p>After</p>';
    const range = rangeForTextOffsets(document.body, 6, 11)!;
    assert.equal(range.toString(), "After");
    assert.equal(selectionTouchesNonTextRow(document.body, range), false);
    const crossing = rangeForTextOffsets(document.body, 0, 11)!;
    assert.equal(selectionTouchesNonTextRow(document.body, crossing), true);
  });
});
