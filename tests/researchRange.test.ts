import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { researchRangeIds, researchRangeStep } from "../src/lib/researchRange";
import { buildSegmentView } from "../src/lib/researchSegmentView";
import { researchNode } from "./researchNodeFixture";

// Registered before the answer column is imported: it imports the editor
// column, whose model menu imports adapter SVG icons.
register("./svgStubLoader.mjs", import.meta.url);
const { ResearchRangeAnswerColumn } = await import("../src/components/research/ResearchAnswerColumn");

const ids = ["a", "b", "c", "d", "e"];

test("a range runs from the anchor to the far end in list order, either way", () => {
  assert.deepEqual(researchRangeIds(ids, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(researchRangeIds(ids, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(researchRangeIds(ids, "a", "e"), ids);
});

test("a range needs two listed rows", () => {
  assert.equal(researchRangeIds(ids, "c", "c"), null);
  assert.equal(researchRangeIds(ids, "c", "z"), null);
  assert.equal(researchRangeIds(ids, "z", "c"), null);
});

test("Shift+arrow steps the far end one row and stops at the list's ends", () => {
  assert.equal(researchRangeStep(ids, "c", 1), "d");
  assert.equal(researchRangeStep(ids, "c", -1), "b");
  assert.equal(researchRangeStep(ids, "e", 1), null);
  assert.equal(researchRangeStep(ids, "a", -1), null);
  assert.equal(researchRangeStep(ids, "z", 1), null);
});

test("a range's answers render in order, without the annotation root, markers or answer menu", () => {
  const nodes = ["first", "second"].map((id) =>
    researchNode({ id, prompt: `Question ${id}`, status: "complete", sessionReady: true }),
  );
  const views = new Map(
    nodes.map((node) => [
      node.id,
      buildSegmentView(
        node,
        {
          node,
          turns: [
            { id: `${node.id}-q`, agentId: "agent", role: "user", blocks: [{ type: "text", text: "q" }], sourceIndex: 0 },
            { id: `${node.id}-a`, agentId: "agent", role: "assistant", blocks: [{ type: "text", text: `Answer ${node.id}` }], sourceIndex: 1 },
          ],
        },
        true,
        false,
      ),
    ]),
  );
  const level = {
    index: 0, headId: "first", chainIds: ["first", "second"], displayIds: ["first", "second"],
    selectedId: "first", sourceId: null, anchor: null, kind: "root" as const,
  };
  const html = renderToStaticMarkup(
    createElement(ResearchRangeAnswerColumn, {
      column: { id: "A0", role: "answer", level, nodeId: "first" },
      nodes,
      views,
      contentErrors: {},
      current: true,
    }),
  );
  assert.ok(html.indexOf("Question first") < html.indexOf("Answer first"));
  assert.ok(html.indexOf("Answer first") < html.indexOf("Question second"));
  assert.ok(html.indexOf("Question second") < html.indexOf("Answer second"));
  assert.match(html, /2 messages selected/);
  assert.doesNotMatch(html, /research-response-content-root|research-branch-marker|Answer actions/);
});
