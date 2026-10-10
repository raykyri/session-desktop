import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchMessageRow,
  ResearchTimelineItem,
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

const noop = () => {};
type RowProps = Parameters<typeof ResearchMessageRow>[0];
const row = (node: ResearchNode, overrides: Partial<RowProps> = {}) =>
  renderToStaticMarkup(
    createElement(ResearchMessageRow, {
      node,
      level: 0,
      label: node.prompt,
      showPrompt: true,
      selected: false,
      now: NOW,
      starrable: false,
      branchCount: 0,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: false,
      registerSegmentElement: noop,
      onSelect: noop,
      onTogglePromoted: noop,
      onShowBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
      ...overrides,
    }),
  );

test("research prompts preserve Markdown blockquotes", () => {
  const html = row(questionNode());

  assert.doesNotMatch(html, /Claude Fable/);
  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /research-user-message research-prompt/);
  assert.doesNotMatch(html, /research-content-card/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /foo<br\/>[\n]?bar/);
});

test("a message row's meta line shows short time, star, branch count and … with even spacing", () => {
  const html = row(questionNode({ inline: true, parentNodeId: "root", promotedAt: NOW }), {
    selected: true,
    starrable: true,
    branchCount: 3,
    branchOpen: true,
    branchUnread: true,
  });

  assert.match(html, /research-msg-meta"><time[^>]*>2d<\/time>/);
  assert.match(html, /research-msg-star is-on"[^>]*aria-pressed="true"/);
  assert.match(html, /research-msg-branches is-open"/);
  // The unread dot is announced as part of the button's name.
  assert.match(html, /aria-label="3 branches from this answer, one with a new answer"/);
  assert.match(html, /research-turn-unread" aria-hidden="true"/);
  const star = html.indexOf("research-msg-star");
  const branches = html.indexOf("research-msg-branches");
  const more = html.indexOf('aria-label="Answer actions"');
  assert.ok(star >= 0 && branches > star && more > branches);
  // Follow, Bookmark and Move are in the feed row's … menu, not here.
  assert.doesNotMatch(html, /Bookmark|Follow/);
});

test("the branch count shows only once the answer has branches, and the star only where offered", () => {
  const settled = row(questionNode());
  assert.doesNotMatch(settled, /research-msg-branches/);
  assert.doesNotMatch(settled, /research-msg-star/);
  // A branch from the whole answer starts from the … menu.
  assert.match(settled, /aria-label="Answer actions"/);

  const running = row(questionNode({ status: "running", createdAt: NOW - 31 * 60 * 1000 }), {
    starrable: true,
    branchCount: 2,
  });
  assert.match(running, /<time[^>]*>31 min<\/time>/);
  assert.match(running, /research-msg-pill is-run"/);
  assert.match(running, />Running</);
  // Branches appear once the answer has finished.
  assert.doesNotMatch(running, /research-msg-branches/);
});

test("only the selected row is in the tab order", () => {
  assert.match(row(questionNode(), { selected: true }), /class="research-msg-hit"[^>]*aria-current="true"[^>]*tabindex="0"/);
  assert.match(row(questionNode()), /class="research-msg-hit"[^>]*tabindex="-1"/);
});

test("documents and conversations show their title in place of a question", () => {
  const html = row(questionNode({ kind: "document", origin: "imported" }), {
    label: "Imported report",
    showPrompt: false,
  });
  assert.doesNotMatch(html, /research-prompt/);
  assert.match(html, /research-msg-plain">Imported report</);
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
  const html = row(questionNode({ prompt: "Why?" }), { replyQuote: "Selected   reply\npassage" });

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
