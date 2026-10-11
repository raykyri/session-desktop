import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchPostThread, { postThreadEntries } from "../src/components/research/ResearchPostThread";
import { postFollowUpCopy } from "../src/components/research/ResearchPost";
import type { ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const noop = () => {};
const asyncNoop = async () => {};

const postFields = {
  id: "post", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", type: "post", format: "text",
  status: "complete", createdAt: 100, highlights: [],
  delivery: { status: "posted", postedAt: 100 },} satisfies NodeFixture;
const post = researchNode(postFields);

const withRepliesFields = {
  ...postFields,
  delivery: {
    status: "posted", postedAt: 100,
    replies: [{
      id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
      body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
    }, {
      id: "r1-response", author: { kind: "author" }, inReplyTo: "r1",
      body: "Which version?", createdAt: 120,
    }, {
      id: "r2", author: { kind: "member", id: "ana", displayName: "Ana Moreau" },
      body: "We stayed on plain WASI.", createdAt: 150,
    }],
  },} satisfies NodeFixture;
const withReplies = researchNode(withRepliesFields);
const aboutFields = {
  ...postFields, id: "about", parentNodeId: "post", type: "exchange", delivery: null,
  anchor: { kind: "reply", replyId: "r1" },
  prompt: "How large is the generated surface?", status: "running", createdAt: 130,} satisfies NodeFixture;
const about = researchNode(aboutFields);
const answeredFields = {
  ...postFields, id: "answered", parentNodeId: "post", type: "exchange", delivery: null,
  prompt: "Which runtimes support it?", status: "complete", createdAt: 160,} satisfies NodeFixture;
const answered = researchNode(answeredFields);
const noteFields = {
  ...postFields, id: "note", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140,
  delivery: null,} satisfies NodeFixture;
const note = researchNode(noteFields);

function render(nodes: ResearchNode[], options: { openNodeId?: string | null; archived?: boolean } = {}) {
  return renderToStaticMarkup(createElement(ResearchPostThread, {
    nodes, post: nodes[0], archived: options.archived ?? false, requireCmdEnterToSend: true,
    openNodeId: options.openNodeId ?? null,
    actions: { onAskFollowUp: asyncNoop, onRetry: asyncNoop },
    onOpenFollowUp: noop,
  }));
}

test("an empty follow-ups column has the composer and says it has no follow-ups", () => {
  const html = render([post]);
  assert.match(html, /<p class="post-thread-empty">No follow-ups yet\.<\/p>/);
  assert.doesNotMatch(html, /post-thread-rows|data-research-thread-row/);
  // The composer starts in Ask. Empty and unfocused, it is one line: the
  // Ask/Note switch and Send appear once it is focused.
  assert.match(html, /class="research-composer-wrap post-composer is-full-width"/);
  assert.match(html, /placeholder="Ask a follow-up"/);
  assert.doesNotMatch(html, /post-composer-row|new-research-switch|research-composer-send/);
  assert.ok(html.indexOf("post-composer") < html.indexOf("post-thread-empty"));
});

test("the composer comes first, then follow-ups as rows, oldest first; stored replies are not shown", () => {
  const html = render([withReplies, answered, about, note]);
  assert.ok(html.indexOf("post-composer") < html.indexOf("post-thread-rows"));
  assert.match(html, /<ol class="post-thread-list post-thread-rows" aria-label="Follow-ups">/);
  const order = [
    "How large is the generated surface?",
    "Anyone measured wizer?",
    "Which runtimes support it?",
  ].map((text) => html.indexOf(text));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || order[i - 1] < index)), String(order));
  // Replies, the author's responses and their controls do not render.
  assert.doesNotMatch(html, /wit-bindgen doubled|Which version\?|We stayed on plain WASI|Ben Kowalski|Ana Moreau/);
  assert.doesNotMatch(html, /Respond|Ask AI about this|Delete|post-avatar|data-type="reply"|is-nested/);
  assert.equal(html.match(/data-research-thread-row=""/g)?.length, 3);
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
  // Each row names its node, for ⌃Tab with focus kept in a text field.
  assert.deepEqual(
    [...html.matchAll(/data-thread-key="([^"]+)"/g)].map((match) => match[1]),
    ["about", "note", "answered"],
  );
  // The first row is the one in the tab order.
  assert.match(html, /data-thread-key="about" data-node-id="about"[^>]*tabindex="0"/);
});

test("a follow-up note's row shows its text; an AI follow-up's row its answer state", () => {
  const html = render([withReplies, answered, about, note]);
  // A follow-up note: the note glyph and text, no status line or reply count.
  assert.match(html, /title="Open this note"/);
  assert.match(html, /lucide-sticky-note/);
  assert.match(html, /Anyone measured wizer\?<\/div><\/div>/);
  assert.doesNotMatch(html, /\d+ repl(y|ies)|lucide-globe|network/i);
  // An AI follow-up: answering, or answered (no preview of the answer). One
  // asked about a stored reply does not name the reply.
  assert.match(html, /<span>asked Claude Fable<\/span>/);
  assert.doesNotMatch(html, /about Ben Kowalski’s reply/);
  assert.match(html, />Answering</);
  assert.match(html, /Which runtimes support it\?<\/div><div class="post-thread-meta">Answered<\/div>/);
  assert.doesNotMatch(html, /Open answer|post-segment/);
});

test("the open follow-up's row is selected and in the tab order", () => {
  const html = render([withReplies, answered, about, note], { openNodeId: "note" });
  assert.match(
    html,
    /<li class="post-thread-item post-thread-follow-up is-selected" data-type="follow-up"><button type="button" class="post-thread-hit" data-research-thread-row="" data-thread-key="note" data-node-id="note" aria-current="true"[^>]*tabindex="0"/,
  );
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
});

test("an archived note has rows but no composer", () => {
  const html = render([withReplies, answered], { archived: true });
  assert.doesNotMatch(html, /research-composer/);
  assert.match(html, /Which runtimes support it\?/);
});

test("a saved link's follow-ups column has the same composer as a note's", () => {
  const link = researchNode({ ...postFields, prompt: "https://example.com/page", format: "link", delivery: null });
  const html = render([link]);
  assert.match(html, /placeholder="Ask a follow-up"/);
  // Collapsed while empty; the Ask/Note switch appears once it is focused.
  assert.doesNotMatch(html, /new-research-switch|Post to network/);
  assert.match(html, /No follow-ups yet\./);
});

test("follow-up rows skip documents and break time ties by id", () => {
  const documentFields = { ...postFields, id: "doc", parentNodeId: "post", type: "document", createdAt: 105 } satisfies NodeFixture;
  const document = researchNode(documentFields);
  const tieBFields = { ...aboutFields, id: "b", createdAt: 170 } satisfies NodeFixture;
  const tieB = researchNode(tieBFields);
  const tieAFields = { ...aboutFields, id: "a", createdAt: 170 } satisfies NodeFixture;
  const tieA = researchNode(tieAFields);
  assert.deepEqual(
    postThreadEntries([withReplies, document, tieB, tieA], withReplies).map((entry) => entry.id),
    ["a", "b"],
  );
});

test("an edited note's follow-ups column lists only its follow-ups", () => {
  const edited = researchNode({ ...withRepliesFields, prompt: "Who ships wit-bindgen 0.30 plugins?", editedAt: 135 });
  const nodes = [edited, about, answered];
  // The column header's count is the number of follow-ups.
  assert.deepEqual(
    postThreadEntries(nodes, edited).map((entry) => entry.id),
    ["about", "answered"],
  );
  const html = render(nodes);
  assert.equal(html.match(/data-research-thread-row=""/g)?.length, 2);
  assert.doesNotMatch(html, /[Cc]orrection|wit-bindgen 0\.30/);
});

test("the follow-up box asks by default and adds a note in Note mode", () => {
  assert.deepEqual(postFollowUpCopy(false, "Ask a follow-up", "Ask Claude Fable"), {
    placeholder: "Ask a follow-up",
    sendName: "Ask",
    sendTitle: "Ask Claude Fable",
  });
  assert.deepEqual(postFollowUpCopy(true, "Ask a follow-up", "Ask Claude Fable"), {
    placeholder: "Add a note",
    sendName: "Add note",
    sendTitle: "Add note",
  });
});
