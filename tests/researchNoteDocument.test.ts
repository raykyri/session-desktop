import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchNoteDocument from "../src/components/research/ResearchNoteDocument";
import type { ResearchNode, ResearchTreeDetail } from "../src/types";

const noop = () => {};
const asyncNoop = async () => {};

const note: ResearchNode = {
  id: "note", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", worktreeDir: "/ws", kind: "note",
  status: "complete", createdAt: 100, highlights: [],
  delivery: { status: "posted", postedAt: 100 },
};

function render(nodes: ResearchNode[], selected: ResearchNode = nodes[0]) {
  const detail: ResearchTreeDetail = {
    tree: {
      id: "tree", title: "Who ships component-model plugins?", rootNodeId: "note",
      workspaceId: "ws", createdAt: 100, updatedAt: 100,
    },
    nodes,
  };
  return renderToStaticMarkup(createElement(ResearchNoteDocument, {
    detail, note: selected, archived: false, followed: false, bookmarked: false,
    actions: {
      onAskFollowUp: asyncNoop, onRespond: asyncNoop, onDeleteResponse: asyncNoop, onRetry: asyncNoop,
    },
    canGoBack: false, canGoForward: false, onBack: noop, onForward: noop,
    onToggleFollow: noop, onToggleBookmark: noop, onSelectNode: noop,
  }));
}

test("a note page shows the reply placeholder before any reply", () => {
  const html = render([note]);
  assert.match(html, /note-document-kind">Note</);
  assert.match(html, /Posted to network · /);
  assert.match(html, />Replies<\/h2>/);
  assert.match(html, /No replies yet\. Replies from your network will appear here\./);
  assert.doesNotMatch(html, />Follow-ups/);
  assert.match(html, /placeholder="Ask a follow-up about this note"/);
  assert.match(html, />Network<\/button>/);
});

test("a note page groups replies, then follow-ups with the reply they ask about", () => {
  const withReplies: ResearchNode = {
    ...note,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
      }],
    },
  };
  const about: ResearchNode = {
    ...note, id: "about", parentNodeId: "note", kind: "run", delivery: null, replyAnchor: "r1",
    prompt: "How large is the generated surface?", status: "running", createdAt: 130,
  };
  const network: ResearchNode = {
    ...note, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,
  };
  const html = render([withReplies, about, network]);
  assert.match(html, />Replies · 1<\/h2>/);
  assert.match(html, />Follow-ups · 2<\/h2>/);
  assert.ok(html.indexOf("wit-bindgen doubled") < html.indexOf(">Follow-ups"));
  assert.match(html, /about Ben Kowalski’s reply/);
  assert.match(html, /research-prompt-quote">wit-bindgen doubled our SDK surface\.</);
  assert.match(html, />Answering</);
  assert.match(html, /↳ Posted to network · 0 replies/);
  assert.match(html, /Anyone measured wizer\?/);
});

test("a network follow-up's page links back to its note and omits Follow and Bookmark", () => {
  const child: ResearchNode = {
    ...note, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,
  };
  const html = render([note, child], child);
  assert.match(html, /Network follow-up of “Who ships component-model plugins\?”/);
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("a saved link page has no Replies group and takes AI follow-ups only", () => {
  const link: ResearchNode = { ...note, prompt: "https://example.com/page", delivery: null };
  const html = render([link]);
  assert.match(html, /note-link-card/);
  assert.match(html, /Saved link · /);
  assert.doesNotMatch(html, />Replies/);
  assert.doesNotMatch(html, />Network<\/button>/);
});
