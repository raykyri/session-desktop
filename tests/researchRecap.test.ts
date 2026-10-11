import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchRecap from "../src/components/research/ResearchRecap";
import ResearchRecapDialog from "../src/components/research/ResearchRecapDialog";
import type { ResearchNodeContent } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const RECAP = { text: "The result is ready.", responseRevision: "revision" };

function content(fields: NodeFixture = {}): ResearchNodeContent {
  return {
    node: researchNode({ prompt: "Question", recap: RECAP, ...fields }),
    turns: [], responseRevision: "revision",
  };
}
const render = (value: ResearchNodeContent) => renderToStaticMarkup(createElement(ResearchRecap, { content: value }));

test("recaps reserve no space until generated and belonging to the displayed answer", () => {
  const value = content();
  assert.match(render(value), /Recap: The result is ready\./);
  value.responseRevision = "different";
  assert.equal(render(value), "");
  assert.equal(render(content({ status: "running" })), "");
  assert.equal(render(content({ recap: null })), "");
});

test("imported reports show their recap; other documents and posts do not", () => {
  assert.match(
    render(content({ type: "document", source: "imported" })),
    /Recap: The result is ready\./,
  );
  assert.equal(render(content({ type: "document" })), "");
  assert.equal(render(content({ type: "document", source: "transcript" })), "");
  assert.equal(render(content({ type: "post" })), "");
});

test("a pending recap job holds the recap slot with a spinner", () => {
  const pending = (input: ResearchNodeContent) =>
    renderToStaticMarkup(createElement(ResearchRecap, { content: input, pending: true }));
  // A current recap always wins over the placeholder.
  assert.match(pending(content()), /Recap: The result is ready\./);
  const missing = content({ recap: null });
  assert.match(pending(missing), /Generating recap/);
  assert.equal(render(missing), "");
  // A stale recap generates again, so its slot shows the spinner, not the text.
  const stale = content({ recap: { text: "Stale.", responseRevision: "older" } });
  assert.match(pending(stale), /Generating recap/);
  assert.doesNotMatch(pending(stale), /Stale\./);
  // Nothing to recap yet on a run that has not settled.
  assert.equal(pending(content({ status: "running", recap: null })), "");
});

test("recaps render as text, with no Markdown or HTML interpretation", () => {
  const value = content({ recap: { ...RECAP, text: "<script>alert(1)</script> **text**" } });
  const html = render(value);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("**text**"));
  assert.ok(!html.includes("<strong>"));
  assert.equal(render(content({ type: "document" })), "");
});

test("current recaps render without an inline regeneration control", () => {
  const html = render(content());
  assert.match(html, /Recap: The result is ready\./);
  assert.doesNotMatch(html, /Generate recap/);
  assert.doesNotMatch(html, /<button/);
});

test("candidate dialog presents the current recap before generation", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchRecapDialog, {
      content: content(),
      onClose: () => undefined,
      onApplied: () => undefined,
    }),
  );
  assert.match(html, /Generate recap/);
  assert.doesNotMatch(html, /The current recap stays unchanged until you apply a candidate/);
  assert.match(html, /The result is ready\./);
  assert.match(html, /Generate candidate/);
  assert.ok(html.indexOf(">Candidate<") < html.indexOf(">Current<"));
  assert.match(html, /settings-input research-recap-instructions/);
  assert.match(html, /launcher-select-trigger/);
  assert.match(html, /settings-input research-recap-control/);
  assert.doesNotMatch(html, /<datalist/);
  assert.match(html, /<hr class="research-recap-comparison-divider"/);
  assert.match(html, /Generate a new recap first\./);
  assert.ok(html.indexOf("Generate candidate") < html.indexOf(">Candidate<"));
});
