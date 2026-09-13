import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchRecap from "../src/components/research/ResearchRecap";
import ResearchRecapDialog from "../src/components/research/ResearchRecapDialog";
import type { ResearchNodeContent } from "../src/types";

function content(): ResearchNodeContent {
  return {
    node: {
      id: "node", treeId: "tree", prompt: "Question", adapter: "claude",
      groupId: "group", worktreeDir: "/tmp", status: "complete", createdAt: 1,
      highlights: [], recap: { text: "Read Cusk and Heti.", responseRevision: "revision" },
    },
    turns: [], children: [], responseRevision: "revision",
  };
}
const render = (value: ResearchNodeContent) => renderToStaticMarkup(createElement(ResearchRecap, { content: value }));

test("recaps reserve no space until generated and belonging to the displayed answer", () => {
  const value = content();
  assert.match(render(value), /Summary: Read Cusk and Heti\./);
  value.responseRevision = "different";
  assert.equal(render(value), "");
  value.responseRevision = "revision";
  value.node.status = "running";
  assert.equal(render(value), "");
  value.node.status = "complete";
  delete value.node.recap;
  assert.equal(render(value), "");
});

test("recaps render as text, with no Markdown or HTML interpretation", () => {
  const value = content();
  value.node.recap!.text = "<script>alert(1)</script> **text**";
  const html = render(value);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("**text**"));
  assert.ok(!html.includes("<strong>"));
  value.node.kind = "document";
  assert.equal(render(value), "");
});

test("current recaps expose regeneration without changing their text", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchRecap, { content: content(), onRegenerate: () => undefined }),
  );
  assert.match(html, /Summary: Read Cusk and Heti\./);
  assert.match(html, /aria-label="Regenerate summary"/);
});

test("candidate dialog presents the current recap before generation", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchRecapDialog, {
      content: content(),
      onClose: () => undefined,
      onApplied: () => undefined,
    }),
  );
  assert.match(html, /Regenerate summary/);
  assert.match(html, /The current summary stays unchanged until you apply a candidate/);
  assert.match(html, /Read Cusk and Heti\./);
  assert.match(html, /Generate candidate/);
});
