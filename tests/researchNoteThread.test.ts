import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchNoteThread, { noteThreadEntries } from "../src/components/research/ResearchNoteThread";
import type { ResearchNode } from "../src/types";

const noop = () => {};
const asyncNoop = async () => {};

const note: ResearchNode = {
  id: "note", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", worktreeDir: "/ws", kind: "note",
  status: "complete", createdAt: 100, highlights: [],
  delivery: { status: "posted", postedAt: 100 },
};

const withReplies: ResearchNode = {
  ...note,
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
  },
};
const about: ResearchNode = {
  ...note, id: "about", parentNodeId: "note", kind: "run", delivery: null, replyAnchor: "r1",
  prompt: "How large is the generated surface?", status: "running", createdAt: 130,
};
const answered: ResearchNode = {
  ...note, id: "answered", parentNodeId: "note", kind: "run", delivery: null,
  prompt: "Which runtimes support it?", status: "complete", createdAt: 160,
};
const network: ResearchNode = {
  ...note, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,
  delivery: {
    status: "posted", postedAt: 140,
    replies: [{
      id: "n1", author: { kind: "member", id: "kai", displayName: "Kai" }, body: "Yes.", createdAt: 145,
    }],
  },
};

function render(nodes: ResearchNode[], options: { openNodeId?: string | null; archived?: boolean } = {}) {
  return renderToStaticMarkup(createElement(ResearchNoteThread, {
    nodes, note: nodes[0], archived: options.archived ?? false, requireCmdEnterToSend: true,
    openNodeId: options.openNodeId ?? null,
    actions: {
      onAskFollowUp: asyncNoop, onRespond: asyncNoop, onDeleteResponse: asyncNoop, onRetry: asyncNoop,
    },
    onOpenFollowUp: noop,
  }));
}

test("an empty thread has the composer and says it has no replies or follow-ups", () => {
  const html = render([note]);
  assert.match(html, /<p class="note-thread-empty">No replies or follow-ups yet\.<\/p>/);
  assert.doesNotMatch(html, /note-thread-rows|data-research-thread-row/);
  // The composer posts to the network by default. Empty and unfocused, it
  // is one line: the Post and Ask switch and Send appear once it is focused.
  assert.match(html, /class="research-composer-wrap note-composer is-full-width"/);
  assert.match(html, /placeholder="Post a follow-up"/);
  assert.doesNotMatch(html, /note-composer-row|new-research-switch|research-composer-send/);
  assert.ok(html.indexOf("note-composer") < html.indexOf("note-thread-empty"));
});

test("the composer comes first, then replies and follow-ups as rows, oldest first", () => {
  const html = render([withReplies, answered, about, network]);
  assert.ok(html.indexOf("note-composer") < html.indexOf("note-thread-rows"));
  const order = [
    "wit-bindgen doubled",
    "How large is the generated surface?",
    "Anyone measured wizer?",
    "We stayed on plain WASI.",
    "Which runtimes support it?",
  ].map((text) => html.indexOf(text));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || order[i - 1] < index)), String(order));
  // An author's response is part of its reply's row, nested under it.
  assert.ok(html.indexOf("wit-bindgen doubled") < html.indexOf("Which version?"));
  assert.ok(html.indexOf("Which version?") < html.indexOf("How large is the generated surface?"));
  assert.match(html, /<ol class="note-thread-list is-nested">/);
  assert.equal(html.match(/data-research-thread-row=""/g)?.length, 5);
  // The first row is the one in the tab order.
  assert.match(html, /<li class="note-thread-item" data-type="reply" tabindex="0" data-research-thread-row="">/);
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
});

test("a follow-up row shows its reply count or its answer state", () => {
  const html = render([withReplies, answered, about, network]);
  // A network follow-up: its replies.
  assert.doesNotMatch(html, /posted to network/);
  assert.match(html, /Anyone measured wizer\?<\/div><div class="note-thread-meta">1 reply<\/div>/);
  // An AI follow-up: answering, or answered (no preview of the answer).
  assert.match(html, /asked Claude Fable about Ben Kowalski’s reply/);
  assert.match(html, />Answering</);
  assert.match(html, /Which runtimes support it\?<\/div><div class="note-thread-meta">Answered<\/div>/);
  assert.doesNotMatch(html, /Open answer|note-segment/);
  const empty = render([note, { ...network, delivery: { status: "posted", postedAt: 140 } }]);
  // With no replies, the row shows no status line.
  assert.match(empty, /Anyone measured wizer\?<\/div><\/div>/);
  assert.doesNotMatch(empty, /No replies yet/);
});

test("the open follow-up's row is selected and in the tab order", () => {
  const html = render([withReplies, answered, about, network], { openNodeId: "net" });
  assert.match(
    html,
    /<li class="note-thread-item note-thread-follow-up is-selected" data-type="follow-up"><button type="button" class="note-thread-hit" data-research-thread-row="" data-node-id="net" aria-current="true"[^>]*tabindex="0"/,
  );
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
});

test("an archived thread has rows but no composer", () => {
  const html = render([withReplies], { archived: true });
  assert.doesNotMatch(html, /research-composer/);
  assert.match(html, /wit-bindgen doubled/);
});

test("a saved link's thread can only ask", () => {
  const link: ResearchNode = { ...note, prompt: "https://example.com/page", delivery: null };
  const html = render([link]);
  assert.match(html, /placeholder="Ask a follow-up"/);
  // Collapsed while empty, and with no Post option it has no switch.
  assert.doesNotMatch(html, /new-research-switch|Post to network/);
  assert.match(html, /No replies or follow-ups yet\./);
});

test("thread entries skip documents and responses and break time ties by id", () => {
  const document: ResearchNode = { ...note, id: "doc", parentNodeId: "note", kind: "document", createdAt: 105 };
  const tieB: ResearchNode = { ...about, id: "b", createdAt: 170 };
  const tieA: ResearchNode = { ...about, id: "a", createdAt: 170 };
  assert.deepEqual(
    noteThreadEntries([withReplies, document, tieB, tieA], withReplies).map((entry) => entry.key),
    ["reply:r1", "reply:r2", "a", "b"],
  );
});
