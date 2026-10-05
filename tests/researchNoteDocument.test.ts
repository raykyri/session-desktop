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

test("a note page leads with the note and posts follow-ups by default", () => {
  const html = render([note]);
  assert.doesNotMatch(html, /note-document-kind/);
  assert.match(html, /note-document-heading/);
  // An empty note says so in its meta line instead of an empty section.
  assert.match(html, /Posted to network · [^<]* · No replies yet/);
  assert.doesNotMatch(html, />Activity/);
  // Delivery and time lead the meta row; Follow and Bookmark follow it.
  assert.ok(html.indexOf("Posted to network") < html.indexOf("research-thread-actions"));
  // The header names the page only after its heading scrolls away.
  assert.match(html, /research-breadcrumb is-title-hidden/);
  // Post is the default action; Ask is in the destination menu.
  assert.match(html, /placeholder="Post a follow-up to your network"/);
  assert.match(html, /note-followup-send"[^>]*><span>Post<\/span>/);
  assert.match(html, /aria-label="Follow-up destination"/);
});

test("a note page lists replies and follow-ups as one activity list in time order", () => {
  const withReplies: ResearchNode = {
    ...note,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
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
  const network: ResearchNode = {
    ...note, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,
  };
  const html = render([withReplies, about, network]);
  assert.match(html, />Activity <span class="note-document-group-count">4<\/span><\/h2>/);
  assert.doesNotMatch(html, />Replies|>Follow-ups| · No replies yet/);
  const order = ["wit-bindgen doubled", "How large is the generated surface?", "Anyone measured wizer?", "We stayed on plain WASI."]
    .map((text) => html.indexOf(text));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || order[i - 1] < index)), String(order));
  assert.match(html, /asked Claude Fable about Ben Kowalski’s reply/);
  assert.match(html, />Answering</);
  assert.match(html, /posted to network/);
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
  assert.doesNotMatch(html, />Activity|No replies yet/);
  // A saved link can only ask, so its button is Ask with no destination menu.
  assert.match(html, /placeholder="Ask a follow-up about this note"/);
  assert.match(html, /note-followup-send"[^>]*><span>Ask<\/span>/);
  assert.doesNotMatch(html, /Follow-up destination/);
});
