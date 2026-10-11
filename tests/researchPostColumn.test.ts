import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchPostColumn from "../src/components/research/ResearchPostColumn";
import type { ResearchNode, ResearchTreeDetail } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const noop = () => {};

const postFields = {
  id: "post", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", type: "post", format: "text",
  status: "complete", createdAt: 100, highlights: [],
  delivery: { status: "posted", postedAt: 100 },} satisfies NodeFixture;
const post = researchNode(postFields);

function render(nodes: ResearchNode[], selected: ResearchNode = nodes[0]) {
  const detail: ResearchTreeDetail = {
    tree: {
      id: "tree", title: "Who ships component-model plugins?", rootNodeId: "post",
      workspaceId: "ws", createdAt: 100, updatedAt: 100,
    },
    nodes,
  };
  return renderToStaticMarkup(createElement(ResearchPostColumn, { detail, post: selected, onSelectNode: noop }));
}

test("a note's column uses the turn layout for the note only", () => {
  const html = render([post]);
  assert.doesNotMatch(html, /post-kind/);
  // Use the turn's question section for the post, with no answer section.
  assert.match(html, /<article class="research-turn post-turn">/);
  assert.match(html, /class="research-turn-question"/);
  assert.match(html, /research-prompt research-turn-prompt"/);
  assert.doesNotMatch(html, /research-turn-answer|post-status|Posted to your network|No replies yet/);
  // The column header contains the title and history, so the body repeats
  // neither; follow-ups and the composer are in the follow-ups column.
  assert.doesNotMatch(html, /research-thread-actions|research-breadcrumb/);
  assert.doesNotMatch(html, /research-composer|post-thread/);
});

test("a note's column shows no stored replies or follow-ups", () => {
  const withActivityFields = {
    ...postFields,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
      }],
    },} satisfies NodeFixture;
  const withActivity = researchNode(withActivityFields);
  const followUpFields = {
    ...postFields, id: "net", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
  const followUp = researchNode(followUpFields);
  const html = render([withActivity, followUp]);
  assert.doesNotMatch(html, />Activity|post-group/);
  assert.doesNotMatch(html, /wit-bindgen doubled|Anyone measured wizer/);
});

test("a follow-up note's page links back to its parent note", () => {
  const childFields = {
    ...postFields, id: "net", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
  const child = researchNode(childFields);
  const html = render([post, child], child);
  assert.match(html, /↳ Follow-up to “Who ships component-model plugins\?”/);
  assert.doesNotMatch(html, /network/i);
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("a saved link's post column shows the link card", () => {
  const linkFields = {
    ...postFields,
    prompt: "https://example.com/page",
    format: "link",
    delivery: null,} satisfies NodeFixture;
  const link = researchNode(linkFields);
  const html = render([link]);
  assert.match(html, /post-link-card/);
  assert.doesNotMatch(html, /Saved the link|No replies yet/);
});

test("a post renders by its stored format, not by parsing its text", () => {
  const askedFields = { ...postFields, prompt: "https://example.com/page", format: "text" } satisfies NodeFixture;
  const asked = researchNode(askedFields);
  assert.doesNotMatch(render([asked]), /post-link-card/);
});


test("an edited post shows its text in place and Edited after its time", () => {
  const edited = researchNode({
    ...postFields,
    prompt: "Who ships wit-bindgen plugins?",
    editedAt: 200,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "We do.", createdAt: 110,
      }],
    },
  });
  const html = render([edited]);
  assert.match(html, /Who ships wit-bindgen plugins\?/);
  assert.match(html, /<div class="research-turn-meta research-post-meta"><time [^>]*>[^<]+<\/time><span aria-hidden="true">·<\/span><span title="Edited [^"]+">Edited<\/span><\/div>/);
  assert.doesNotMatch(html, /[Cc]orrection/);
  // An unedited post has no Edited mark.
  assert.doesNotMatch(render([post]), /Edited/);
});
