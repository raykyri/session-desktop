import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchTimelineItem,
  ResearchTurnQuestion,
} from "../src/components/research/ResearchTurn";
import {
  ResearchMessageBody,
  ResearchUserMessage,
  visibleResearchPrompt,
} from "../src/components/research/ResearchMessage";
import type { ResearchMessageAttachment, ResearchNode } from "../src/types";

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

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function questionNode(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "node",
    treeId: "tree",
    prompt: "> foo\n> bar",
    adapter: "claude",
    groupId: "ws",
    worktreeDir: "/ws",
    status: "complete",
    createdAt: NOW - 2 * 24 * 60 * 60 * 1000,
    highlights: [],
    ...overrides,
  };
}

test("research prompts preserve Markdown blockquotes", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTurnQuestion, { node: questionNode(), showPrompt: true, now: NOW }),
  );

  assert.doesNotMatch(html, /Claude Fable/);
  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /research-user-message research-prompt/);
  assert.doesNotMatch(html, /research-content-card/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /foo<br\/>[\n]?bar/);
});

test("the question meta row shows short time, star, and branch count with even spacing", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTurnQuestion, {
      node: questionNode({ inline: true, parentNodeId: "root", promotedAt: NOW }),
      showPrompt: true,
      now: NOW,
      promotable: true,
      branchCount: 3,
      branchOpen: true,
      branchMenuOpen: true,
      branchUnread: true,
      onTogglePromoted: () => {},
      onBranchButton: () => {},
    }),
  );

  assert.match(html, /research-turn-meta"><time[^>]*>2d<\/time>/);
  assert.match(html, /research-turn-star is-on"[^>]*aria-pressed="true"/);
  assert.match(
    html,
    /research-turn-branches has-count is-open"[^>]*aria-haspopup="menu" aria-expanded="true"/,
  );
  // The unread dot is announced as part of the button's name.
  assert.match(html, /aria-label="3 branches from this answer, one with a new answer"/);
  assert.match(html, /research-turn-unread" aria-hidden="true"/);
  assert.ok(html.indexOf("research-turn-star") < html.indexOf("research-turn-branches"));
  // The thread-level Follow / Bookmark pair moved to the column header.
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("a question without branches offers to start one, or says why it cannot", () => {
  const settled = renderToStaticMarkup(
    createElement(ResearchTurnQuestion, {
      node: questionNode(),
      showPrompt: true,
      now: NOW,
      onBranchButton: () => {},
    }),
  );
  assert.match(settled, /aria-label="Branch from this answer"/);
  assert.doesNotMatch(settled, /aria-haspopup|aria-disabled/);
  // The star is offered only for root-conversation follow-ups.
  assert.doesNotMatch(settled, /research-turn-star/);

  const running = renderToStaticMarkup(
    createElement(ResearchTurnQuestion, {
      node: questionNode({ status: "running", createdAt: NOW - 31 * 60 * 1000 }),
      showPrompt: true,
      now: NOW,
      promotable: true,
      branchBlocker: "Wait for the answer to finish",
      onTogglePromoted: () => {},
      onBranchButton: () => {},
    }),
  );
  assert.match(running, /<time[^>]*>31 min<\/time>/);
  assert.doesNotMatch(running, /research-turn-star/);
  // The branch button stays, disabled with the reason as its tooltip.
  assert.match(
    running,
    /research-turn-branches"[^>]*aria-disabled="true"[^>]*title="Wait for the answer to finish"/,
  );
});

test("documents and conversations show the meta row without a question", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTurnQuestion, {
      node: questionNode({ kind: "document", origin: "imported" }),
      showPrompt: false,
      now: NOW,
    }),
  );
  assert.doesNotMatch(html, /research-prompt/);
  assert.match(html, /<time[^>]*>Imported 2d<\/time>/);
});

test("the shared user-message primitive stays unboxed", () => {
  const html = renderToStaticMarkup(
    createElement(
      ResearchUserMessage,
      { className: "research-conversation-prompt research-prompt", children:
        createElement(ResearchMessageBody, { prompt: "Conversation question" }) },
    ),
  );

  assert.match(
    html,
    /research-user-message research-conversation-prompt research-prompt/,
  );
  assert.doesNotMatch(html, /research-content-card/);
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
    /research-user-message research-response-message research-conversation-prompt research-prompt/,
  );
  assert.doesNotMatch(html, /research-content-card/);
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

test("a follow-up of a note reply quotes the reply above the question", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTurnQuestion, {
      node: questionNode({ prompt: "Why?" }),
      showPrompt: true,
      replyQuote: "Selected   reply\npassage",
      now: NOW,
    }),
  );

  assert.match(html, /research-prompt-quote">Selected reply passage<\/blockquote>/);
  assert.ok(html.indexOf("Selected reply passage") < html.indexOf("research-user-message"));
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


test("long imported reports retain Markdown and their final conclusion", () => {
  const html = renderToStaticMarkup(createElement(ResearchTimelineItem, {
    imported: true,
    item: {
      type: "message", key: "imported-report", role: "assistant",
      blocks: [{ type: "text", text: "# Long report\n\n" + "Evidence. ".repeat(35_000) + "\n\n**Final conclusion.**" }],
      activities: [], sourceTurnIds: ["imported"], blockSourceTurnIds: ["imported"],
    },
  }));
  assert.match(html, /<h1>Long report<\/h1>/);
  assert.match(html, /<strong>Final conclusion\.<\/strong>/);
  assert.doesNotMatch(html, /research-plaintext/);
});


test("imported reports hide ChatGPT citation handles and preserve Markdown sources", () => {
  const html = renderToStaticMarkup(createElement(ResearchTimelineItem, {
    imported: true,
    item: {
      type: "message", key: "imported-citations", role: "assistant",
      blocks: [{ type: "text", text: "Finding. \uE200cite\uE202turn25view0\uE202turn22view1\uE201\n\n[Source](https://example.com/paper) [1]\n\nAnother finding.\uE200cite\uE202turn19search24\uE201" }],
      activities: [], sourceTurnIds: ["imported"], blockSourceTurnIds: ["imported"],
    },
  }));
  assert.match(html, /<p>Finding\.<\/p>/);
  assert.match(html, /href="https:\/\/example.com\/paper"/);
  assert.match(html, /\[1\]/);
  assert.match(html, /<p>Another finding\.<\/p>/);
  assert.doesNotMatch(html, /turn25view0|turn22view1|turn19search24|[\uE200-\uE202]/);
});
