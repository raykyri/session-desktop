import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchNoteDocument, { noteDeliveryText } from "../src/components/research/ResearchNoteDocument";
import type { ResearchNode, ResearchTreeDetail } from "../src/types";

const noop = () => {};

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
  return renderToStaticMarkup(createElement(ResearchNoteDocument, { detail, note: selected, onSelectNode: noop }));
}

test("a note's post column uses the turn layout for its text and delivery status", () => {
  const html = render([note]);
  assert.doesNotMatch(html, /note-document-kind/);
  // Use the turn's question section for the note and answer section for delivery.
  assert.match(html, /<article class="research-turn note-turn">/);
  assert.match(html, /class="research-turn-question"/);
  assert.match(html, /research-prompt research-turn-prompt"/);
  assert.match(html, /class="research-turn-answer"/);
  assert.match(html, /<p class="note-document-status">Posted to your network\. No replies yet\.<\/p>/);
  assert.ok(html.indexOf("research-turn-question") < html.indexOf("Posted to your network"));
  // The column header carries the title and history, so the body repeats
  // neither; replies, follow-ups and the composer are in the thread column.
  assert.doesNotMatch(html, /research-thread-actions|research-breadcrumb/);
  assert.doesNotMatch(html, /research-composer|note-thread/);
});

test("a note's post column has no Activity section", () => {
  const withActivity: ResearchNode = {
    ...note,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
      }],
    },
  };
  const followUp: ResearchNode = {
    ...note, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,
  };
  const html = render([withActivity, followUp]);
  assert.doesNotMatch(html, />Activity|note-document-group/);
  assert.doesNotMatch(html, /wit-bindgen doubled|Anyone measured wizer/);
  assert.match(html, /<p class="note-document-status">Posted to your network\.<\/p>/);
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

test("a network follow-up's page links back to its note", () => {
  const child: ResearchNode = {
    ...note, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,
  };
  const html = render([note, child], child);
  assert.match(html, /Network follow-up of “Who ships component-model plugins\?”/);
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("a saved link's post column shows the link card", () => {
  const link: ResearchNode = { ...note, prompt: "https://example.com/page", delivery: null };
  const html = render([link]);
  assert.match(html, /note-link-card/);
  assert.match(html, />Saved the link\.</);
  assert.doesNotMatch(html, /No replies yet/);
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
