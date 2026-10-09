import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchNoteDocument, { noteDeliveryText } from "../src/components/research/ResearchNoteDocument";
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
    detail, note: selected, archived: false, requireCmdEnterToSend: true,
    actions: {
      onAskFollowUp: asyncNoop, onRespond: asyncNoop, onDeleteResponse: asyncNoop, onRetry: asyncNoop,
    },
    onSelectNode: noop,
  }));
}

test("a note page reads as a turn and posts follow-ups by default", () => {
  const html = render([note]);
  assert.doesNotMatch(html, /note-document-kind/);
  // Use the turn's question section for the note and answer section for delivery.
  assert.match(html, /<article class="research-turn note-turn">/);
  assert.match(html, /class="research-turn-question"/);
  assert.match(html, /research-prompt research-turn-prompt"/);
  assert.match(html, /class="research-turn-answer"/);
  // An empty note says so where its answer would be, not as an empty section.
  assert.match(html, /<p class="note-document-status">Posted to your network\. No replies yet\.<\/p>/);
  assert.doesNotMatch(html, />Activity/);
  // The page is a column body: the column header carries the title, Follow
  // and Bookmark, so the body repeats none of them.
  assert.doesNotMatch(html, /research-thread-actions|research-breadcrumb/);
  assert.ok(html.indexOf("research-turn-question") < html.indexOf("Posted to your network"));
  // The column's follow-up composer, after the turn, at full width. Post is
  // the default action; Ask is in the destination menu.
  assert.ok(html.indexOf("note-turn") < html.indexOf("research-composer-wrap note-composer"));
  assert.match(html, /<form class="research-composer">/);
  assert.match(html, /placeholder="Post a follow-up to your network"/);
  assert.match(html, /note-composer-destination"[^>]*><span>Post<\/span>/);
  assert.match(html, /aria-label="Follow-up destination: Post to network"/);
  assert.match(html, /title="Post to your network \(⌘↵\)"/);
});

test("a note's delivery line says what was saved and where it went", () => {
  const link = { prompt: "https://example.com/page", attachments: [], delivery: null };
  assert.equal(noteDeliveryText(link, 0), "Saved the link.");
  assert.equal(
    noteDeliveryText({ ...link, delivery: { status: "posted", postedAt: 1 } }, 0),
    "Saved the link and posted it to your network. No replies yet.",
  );
  assert.equal(
    noteDeliveryText({ ...link, delivery: { status: "posted", postedAt: 1 } }, 2),
    "Saved the link and posted it to your network.",
  );
  assert.equal(noteDeliveryText({ prompt: "Who ships it?", delivery: null }, 0), "Saved.");
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

test("a network follow-up's page links back to its note", () => {
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
  assert.match(html, />Saved the link\.</);
  assert.doesNotMatch(html, />Activity|No replies yet/);
  // A saved link can only ask, so it sends with Ask and has no destination.
  assert.match(html, /placeholder="Ask a follow-up about this note"/);
  assert.match(html, /research-composer-send"[^>]*aria-label="Ask"/);
  assert.doesNotMatch(html, /Follow-up destination/);
});

test("a note with a comment and a link counts as a saved link", () => {
  assert.equal(
    noteDeliveryText(
      { prompt: "re: an essay\nhttps://example.com/essay", delivery: { status: "posted", postedAt: 1 } },
      0,
    ),
    "Saved the link and posted it to your network. No replies yet.",
  );
});
