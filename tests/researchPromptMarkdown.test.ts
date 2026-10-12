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
import { nodePrompt } from "../src/lib/researchNodeTypes";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

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

function questionNode(overrides: NodeFixture = {}): ResearchNode {
  return researchNode({
    id: "node",
    treeId: "tree",
    prompt: "> foo\n> bar",
    adapter: "claude",
    groupId: "ws",
    status: "complete",
    createdAt: NOW - 2 * 24 * 60 * 60 * 1000,
    highlights: [],
    ...overrides,
  });
}

const noop = () => {};
type RowProps = Parameters<typeof ResearchMessageRow>[0];
const row = (node: ResearchNode, overrides: Partial<RowProps> = {}) =>
  renderToStaticMarkup(
    createElement(ResearchMessageRow, {
      node,
      level: 0,
      label: nodePrompt(node),
      showPrompt: true,
      selected: false,
      starrable: false,
      branchCount: 0,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: false,
      registerSegmentElement: noop,
      onSelect: noop,
      onToggleBranches: noop,
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

test("a message row's meta line shows the starred mark and branch count, with no time", () => {
  const html = row(questionNode({ inline: true, parentNodeId: "root", starredAt: NOW }), {
    selected: true,
    starrable: true,
    branchCount: 3,
    branchOpen: true,
    branchUnread: true,
  });

  assert.doesNotMatch(html, /<time/);
  assert.match(html, /research-msg-meta"><span class="research-msg-starred" role="img" aria-label="Starred"/);
  assert.match(html, /research-msg-branches is-open"/);
  // The unread dot is announced as part of the button's name.
  assert.match(
    html,
    /aria-label="3 branches from this answer, one selected in the next column, one with a new answer"/,
  );
  // The indicator is an up-right arrow, with no count.
  assert.match(html, /research-msg-branches is-open"[^>]*>(?:(?!<\/button>).)*lucide-arrow-up-right/);
  assert.doesNotMatch(html, /research-tnum/);
  assert.match(html, /research-turn-unread" aria-hidden="true"/);
  const starred = html.indexOf("research-msg-starred");
  const branches = html.indexOf("research-msg-branches");
  const more = html.indexOf('aria-label="Answer actions"');
  assert.ok(starred >= 0 && branches > starred && more > branches);
  // Move to is in the feed row's … menu, not here.
  assert.doesNotMatch(html, /Move to/);
});

test("a settled row with nothing to show has no meta line; the starred mark shows only where offered", () => {
  const settled = row(questionNode());
  assert.doesNotMatch(settled, /research-msg-meta/);
  assert.doesNotMatch(settled, /<time/);
  // A branch from the whole answer starts from the … menu.
  assert.match(settled, /aria-label="Answer actions"/);
  // Starred, but not starrable here (a branch's later follow-up).
  assert.doesNotMatch(row(questionNode({ starredAt: NOW })), /research-msg-starred|research-msg-meta/);

  const running = row(questionNode({ status: "running", createdAt: NOW - 31 * 60 * 1000 }), {
    starrable: true,
    branchCount: 2,
  });
  assert.doesNotMatch(running, /<time/);
  // The running state is the row's glyph, not a pill, so the meta line has
  // nothing to show.
  assert.match(running, /class="research-row-glyph is-running is-tone-running" role="img" aria-label="Running"/);
  assert.doesNotMatch(running, /research-msg-pill|>Running</);
  assert.doesNotMatch(running, /research-msg-meta/);
  // Branches appear once the answer has finished.
  assert.doesNotMatch(running, /research-msg-branches/);
});

test("only the selected row is in the tab order", () => {
  assert.match(row(questionNode(), { selected: true }), /class="research-msg-hit"[^>]*aria-current="true"[^>]*tabindex="0"/);
  assert.match(row(questionNode()), /class="research-msg-hit"[^>]*tabindex="-1"/);
});

test("documents and conversations show their title in place of a question", () => {
  const html = row(questionNode({ type: "document", source: "imported" }), {
    label: "Imported report",
    showPrompt: false,
  });
  assert.doesNotMatch(html, /research-prompt/);
  assert.match(
    html,
    /research-msg-plain"><span class="research-row-glyph is-imported" aria-hidden="true"><svg[^]*?<\/svg><\/span>Imported report</,
  );
  assert.match(html, /research-msg-meta"><span class="research-msg-provenance"[^>]*>Imported<\/span><\/div>/);
});

test("an imported report's row shows the question it answers and the Imported time", () => {
  const html = row(questionNode({ type: "document", source: "imported", prompt: "What did the survey find?" }));
  assert.match(html, /What did the survey find\?/);
  assert.match(html, />Imported</);
  assert.doesNotMatch(html, /<time/);
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

test("root activities are expanded for running answers and collapsed for settled answers", () => {
  const item = {
    type: "message" as const, key: "trace", role: "assistant" as const, blocks: [],
    activities: [
      { type: "tool" as const, key: "tool-1", name: "Read", input: { path: "notes.md" }, isError: false },
      { type: "thinking" as const, key: "thinking-1", values: ["Comparing the two sources."] },
    ],
    sourceTurnIds: ["turn"], blockSourceTurnIds: [],
  };
  const running = renderToStaticMarkup(createElement(ResearchTimelineItem, { item, expandActivities: true }));
  assert.equal(running.match(/<details open=""/g)?.length, 2);
  assert.match(running, /Comparing the two sources\./);
  const settled = renderToStaticMarkup(createElement(ResearchTimelineItem, { item }));
  assert.doesNotMatch(settled, /<details open/);
});
