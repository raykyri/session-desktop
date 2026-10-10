import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchNotePost from "../src/components/research/ResearchNotePost";
import type { ResearchNode, ResearchTreeDetail } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const noop = () => {};

const noteFields = {
  id: "note", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", type: "post", format: "text",
  status: "complete", createdAt: 100, highlights: [],
  delivery: { status: "posted", postedAt: 100 },} satisfies NodeFixture;
const note = researchNode(noteFields);

function render(nodes: ResearchNode[], selected: ResearchNode = nodes[0]) {
  const detail: ResearchTreeDetail = {
    tree: {
      id: "tree", title: "Who ships component-model plugins?", rootNodeId: "note",
      workspaceId: "ws", createdAt: 100, updatedAt: 100,
    },
    nodes,
  };
  return renderToStaticMarkup(createElement(ResearchNotePost, { detail, note: selected, onSelectNode: noop }));
}

test("a note's post column uses the turn layout for the post only", () => {
  const html = render([note]);
  assert.doesNotMatch(html, /note-post-kind/);
  // Use the turn's question section for the note, with no answer section.
  assert.match(html, /<article class="research-turn note-turn">/);
  assert.match(html, /class="research-turn-question"/);
  assert.match(html, /research-prompt research-turn-prompt"/);
  assert.doesNotMatch(html, /research-turn-answer|note-post-status|Posted to your network|No replies yet/);
  // The column header carries the title and history, so the body repeats
  // neither; replies, follow-ups and the composer are in the thread column.
  assert.doesNotMatch(html, /research-thread-actions|research-breadcrumb/);
  assert.doesNotMatch(html, /research-composer|note-thread/);
});

test("a note's post column has no Activity section", () => {
  const withActivityFields = {
    ...noteFields,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
      }],
    },} satisfies NodeFixture;
  const withActivity = researchNode(withActivityFields);
  const followUpFields = {
    ...noteFields, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
  const followUp = researchNode(followUpFields);
  const html = render([withActivity, followUp]);
  assert.doesNotMatch(html, />Activity|note-post-group/);
  assert.doesNotMatch(html, /wit-bindgen doubled|Anyone measured wizer/);
});

test("a network follow-up's page links back to its note", () => {
  const childFields = {
    ...noteFields, id: "net", parentNodeId: "note", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
  const child = researchNode(childFields);
  const html = render([note, child], child);
  assert.match(html, /Network follow-up of “Who ships component-model plugins\?”/);
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("a saved link's post column shows the link card", () => {
  const linkFields = {
    ...noteFields,
    prompt: "https://example.com/page",
    format: "link",
    delivery: null,} satisfies NodeFixture;
  const link = researchNode(linkFields);
  const html = render([link]);
  assert.match(html, /note-link-card/);
  assert.doesNotMatch(html, /Saved the link|No replies yet/);
});

test("a post renders by its stored format, not by parsing its text", () => {
  const askedFields = { ...noteFields, prompt: "https://example.com/page", format: "text" } satisfies NodeFixture;
  const asked = researchNode(askedFields);
  assert.doesNotMatch(render([asked]), /note-link-card/);
});

