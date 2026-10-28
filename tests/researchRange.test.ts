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

test("a message range includes the tail of an unexpanded long transcript", async () => {
  const { ResearchRangeEntry } = await import("../src/components/research/ResearchRangeView");
  const node = researchNode({ type: "document", source: "transcript" });
  const content = { node, turns: Array.from({ length: 120 }, (_, index) => ({
    id: `turn-${index}`, agentId: "agent", role: index % 2 ? "assistant" as const : "user" as const,
    blocks: [{ type: "text" as const, text: `Transcript item ${index}` }], sourceIndex: index,
  })) };
  const view = buildSegmentView(node, content, false, false);
  assert.ok(view.hiddenTimelineItemCount > 0);
  const html = renderToStaticMarkup(createElement(ResearchRangeEntry, { node, view }));
  assert.match(html, /Transcript item 119/);
});

test("a feed range refreshes its answer and status on content signals", async () => {
  const { withWidgetDom } = await import("./widgetDom");
  const { act } = await import("react");
  const { publishResearchContentChanged } = await import("@session/shared/lib/researchContentRefresh");
  const { ResearchFeedRangeView } = await import("../src/components/research/ResearchRangeView");
  await withWidgetDom(async (window) => {
    const { createRoot } = await import("react-dom/client");
    let complete = false;
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => ({
      node: researchNode({ id: "live", status: complete ? "complete" : "running" }),
      turns: [{ id: "answer", agentId: "agent", role: "assistant", sourceIndex: 0,
        blocks: [{ type: "text", text: complete ? "Finished answer" : "Partial answer" }] }],
    }) } });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ResearchFeedRangeView, {
        trees: [{ id: "tree", title: "Live thread", rootNodeId: "live" }], onClear: () => {},
      })));
      assert.match(container.textContent ?? "", /Partial answer/);
      complete = true;
      await act(async () => {
        publishResearchContentChanged("live");
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });
      assert.match(container.textContent ?? "", /Finished answer/);
      assert.doesNotMatch(container.textContent ?? "", /Partial answer|Running/);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

test("extending a feed range retains fallback polling for its running answers", async () => {
  const { withWidgetDom } = await import("./widgetDom");
  const { act } = await import("react");
  const { ResearchFeedRangeView } = await import("../src/components/research/ResearchRangeView");
  await withWidgetDom(async (window) => {
    const { createRoot } = await import("react-dom/client");
    const timers = new Map<number, number>();
    let timerId = 0;
    window.setTimeout = ((_callback: unknown, delay: number) => {
      timers.set(++timerId, delay);
      return timerId;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id: number) => { timers.delete(id); };
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (_command: string, args: { nodeId: string }) => ({
      node: researchNode({ id: args.nodeId, status: args.nodeId === "live" ? "running" : "complete" }),
      turns: [],
    }) } });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const render = (ids: string[]) => act(async () => root.render(createElement(ResearchFeedRangeView, {
      trees: ids.map((id) => ({ id, title: id, rootNodeId: id })), onClear: () => {},
    })));
    try {
      await render(["live", "other"]);
      assert.ok([...timers.values()].includes(10000));
      await render(["live", "other", "third"]);
      assert.ok([...timers.values()].includes(10000));
    } finally {
      await act(async () => root.unmount());
    }
  });
});
