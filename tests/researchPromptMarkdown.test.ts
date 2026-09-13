import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatResearchReplySnippet,
  ResearchSegmentPrompt,
} from "../src/components/research/ResearchDocument";

const promptProps = {
  visible: true,
  parentNodeId: null,
  queryQuote: null,
  prompt: "> foo\n> bar",
  adapter: "claude",
  model: "fable",
  onSelectNode: () => {},
} as const;

test("research prompts preserve Markdown blockquotes", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, { ...promptProps, index: 0 }),
  );

  assert.match(html, /You asked Claude Fable/);
  assert.match(html, /research-prompt research-content-card/);
  assert.doesNotMatch(html, /Reply to:/);
  assert.ok(html.indexOf("You asked Claude Fable") < html.indexOf("<blockquote>"));
  assert.match(html, /<blockquote>/);
  assert.match(html, /foo<br\/>[\n]?bar/);
});

test("follow-up research prompts omit the asked-model line", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, { ...promptProps, index: 1 }),
  );

  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /<blockquote>/);
});

test("follow-up research prompts quote a truncated previous answer", () => {
  assert.equal(
    formatResearchReplySnippet("Ready — what would you like to work on?"),
    "Ready — what would you like to work on?",
  );
  assert.equal(
    formatResearchReplySnippet(
      "The workspace is not a git repository so you will need to initialize one first.",
    ),
    "The workspace is not a git repository so…",
  );

  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 1,
      replyToAnswer:
        "The workspace is not a git repository so you will need to initialize one first.",
    }),
  );

  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /research-prompt-reply/);
  assert.match(html, /Reply to: The workspace is not a git repository so…/);
  assert.doesNotMatch(html, /initialize one first/);
});
