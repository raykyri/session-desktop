import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatResearchReplySnippet,
  ResearchSegmentPrompt,
  ResearchTimelineItem,
} from "../src/components/research/ResearchDocument";
import {
  ResearchMessageBody,
  ResearchUserMessage,
  visibleResearchPrompt,
} from "../src/components/research/ResearchMessage";
import type { ResearchMessageAttachment } from "../src/types";

const tweetAttachment: ResearchMessageAttachment = {
  kind: "tweet",
  schemaVersion: 1,
  sourceUrl: "https://x.com/example/status/123",
  tweetId: "123",
  placement: "trailing",
  provider: "xSyndication",
  status: "resolved",
  attemptedAt: 1,
  fetchedAt: 2,
  tweet: {
    id: "123",
    url: "https://x.com/example/status/123",
    author: { name: "Example", handle: "example", verified: true },
    createdAt: "2026-09-12T12:00:00.000Z",
    runs: [{ kind: "text", text: "Captured post text" }],
    partial: false,
    media: [
      {
        kind: "photo",
        imageUrl: "https://pbs.twimg.com/media/example.jpg",
        altText: "A useful diagram",
        width: 1200,
        height: 800,
      },
    ],
  },
};

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
  assert.match(html, /research-user-message research-content-card research-prompt/);
  assert.doesNotMatch(html, /Reply to:/);
  assert.ok(html.indexOf("You asked Claude Fable") < html.indexOf("<blockquote>"));
  assert.match(html, /<blockquote>/);
  assert.match(html, /foo<br\/>[\n]?bar/);
});

test("the shared user-message primitive owns card composition", () => {
  const html = renderToStaticMarkup(
    createElement(
      ResearchUserMessage,
      { className: "research-conversation-prompt research-prompt" },
      createElement(ResearchMessageBody, { prompt: "Conversation question" }),
    ),
  );

  assert.match(
    html,
    /research-user-message research-content-card research-conversation-prompt research-prompt/,
  );
  assert.match(html, /turn-markdown research-prose research-prose--body/);
});

test("exported conversation prompts use the shared user-message surface", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTimelineItem, {
      conversation: true,
      item: {
        type: "message",
        key: "conversation-user",
        role: "user",
        blocks: [{ type: "text", text: "Conversation question" }],
        activities: [],
        sourceTurnIds: ["turn-1"],
        blockSourceTurnIds: ["turn-1"],
      },
    }),
  );

  assert.match(
    html,
    /research-user-message research-content-card research-response-message research-conversation-prompt research-prompt/,
  );
  assert.match(html, /turn-markdown research-prose research-prose--body/);
});

test("exported conversation assistant messages remain uncarded research prose", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTimelineItem, {
      conversation: true,
      item: {
        type: "message",
        key: "conversation-assistant",
        role: "assistant",
        blocks: [{ type: "text", text: "Conversation answer" }],
        activities: [],
        sourceTurnIds: ["turn-2"],
        blockSourceTurnIds: ["turn-2"],
      },
    }),
  );

  assert.match(html, /research-response-message/);
  assert.match(html, /turn-markdown research-prose research-prose--body/);
  assert.doesNotMatch(html, /research-user-message|research-content-card|research-prompt/);
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

test("resolved trailing tweet URLs are presentation-only while the embed renders", () => {
  const prompt = `What does this mean?\n\n${tweetAttachment.sourceUrl}`;
  assert.equal(visibleResearchPrompt(prompt, [tweetAttachment]), "What does this mean?");

  const html = renderToStaticMarkup(
    createElement(ResearchMessageBody, { prompt, attachments: [tweetAttachment] }),
  );
  assert.match(html, /What does this mean\?/);
  assert.match(html, /Captured post text/);
  assert.match(html, /A useful diagram/);
  assert.doesNotMatch(html, />https:\/\/x\.com\/example\/status\/123</);
});

test("inline or unavailable tweet URLs remain visible", () => {
  const inline = { ...tweetAttachment, placement: "inline" as const };
  const unavailable: ResearchMessageAttachment = {
    ...tweetAttachment,
    status: "unavailable",
    tweet: undefined,
    failure: "timeout",
  };
  const prompt = `Review ${tweetAttachment.sourceUrl}`;
  assert.equal(visibleResearchPrompt(prompt, [inline]), prompt);
  assert.equal(visibleResearchPrompt(prompt, [unavailable]), prompt);
});
