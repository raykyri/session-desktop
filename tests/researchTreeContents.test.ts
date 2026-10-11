import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchTreeDeleteOfferPanel } from "../src/components/research/ResearchTreeMenu";
import { researchTreeContents, researchTreeContentsSentence } from "../src/lib/researchTreeContents";
import type { ResearchTreeSummary } from "../src/types";
import { researchNode } from "./researchNodeFixture";

const member = (id: string, createdAt: number) => ({
  id, author: { kind: "member" as const, id: "ana", displayName: "Ana Moreau" }, body: "Reply", createdAt,
});
const response = (id: string, inReplyTo: string, createdAt: number) => ({
  id, author: { kind: "author" as const }, inReplyTo, body: "Response", createdAt,
});

const post = researchNode({
  id: "post", type: "post", prompt: "Who ships component-model plugins?",
  delivery: { status: "posted", postedAt: 100, replies: [member("r1", 110), response("r1-response", "r1", 120)] },
});
// A network follow-up with one reply, and an AI follow-up asked about r1 that
// continues inline once and has one branch.
const network = researchNode({
  id: "net", type: "post", parentNodeId: "post",
  delivery: { status: "posted", postedAt: 130, replies: [member("n1", 140)] },
});
const aiFollowUp = researchNode({ id: "ai", parentNodeId: "post", anchor: { kind: "reply", replyId: "r1" } });
const aiInline = researchNode({ id: "ai-2", parentNodeId: "ai", inline: true });
const aiBranch = researchNode({ id: "ai-branch", parentNodeId: "ai" });
const networkAi = researchNode({ id: "net-ai", parentNodeId: "net" });

test("a post's replies count every delivery reply, the author's responses included", () => {
  assert.deepEqual(researchTreeContents([post], "post"), {
    rootType: "post", replies: 2, followUps: 0, branches: 0,
  });
});

test("a post's follow-ups are its AI and network follow-ups and theirs; passage follow-ups are branches", () => {
  const contents = researchTreeContents(
    [post, network, aiFollowUp, aiInline, aiBranch, networkAi],
    "post",
  );
  assert.deepEqual(contents, { rootType: "post", replies: 3, followUps: 4, branches: 1 });
  assert.equal(
    researchTreeContentsSentence(contents!),
    "It has 5 messages (4 follow-ups and 1 branch) and 3 replies; deleting the thread also deletes them.",
  );
});

test("a question's inline follow-ups and branches are counted, a branch's later messages as follow-ups", () => {
  const root = researchNode({ id: "q" });
  const nodes = [
    root,
    researchNode({ id: "q-2", parentNodeId: "q", inline: true }),
    researchNode({ id: "q-3", parentNodeId: "q-2", inline: true }),
    researchNode({ id: "b", parentNodeId: "q-2" }),
    researchNode({ id: "b-2", parentNodeId: "b", inline: true }),
  ];
  const contents = researchTreeContents(nodes, "q");
  assert.deepEqual(contents, { rootType: "exchange", replies: 0, followUps: 3, branches: 1 });
  assert.equal(
    researchTreeContentsSentence(contents!),
    "It has 4 messages (3 follow-ups and 1 branch); deleting the thread also deletes them.",
  );
});

test("a document's follow-ups: inline ones and passage branches", () => {
  const doc = researchNode({ id: "doc", type: "document", source: "imported" });
  const nodes = [
    doc,
    researchNode({ id: "d-1", parentNodeId: "doc", inline: true }),
    researchNode({ id: "d-b", parentNodeId: "doc" }),
    researchNode({ id: "d-c", parentNodeId: "doc" }),
  ];
  const contents = researchTreeContents(nodes, "doc");
  assert.deepEqual(contents, { rootType: "document", replies: 0, followUps: 1, branches: 2 });
  assert.equal(
    researchTreeContentsSentence(contents!),
    "It has 3 messages (1 follow-up and 2 branches); deleting the thread also deletes them.",
  );
});

test("one item reads in the singular, and a single kind of message is named", () => {
  const single = researchNode({
    id: "post", type: "post", delivery: { status: "posted", postedAt: 100, replies: [member("r1", 110)] },
  });
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([single], "post")!),
    "It has 1 reply; deleting the thread also deletes it.",
  );
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([single, aiFollowUp], "post")!),
    "It has 1 message (a follow-up) and 1 reply; deleting the thread also deletes them.",
  );
});

test("an empty thread's sentence depends on the root type", () => {
  const bare = researchNode({ id: "post", type: "post", delivery: null });
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([bare], "post")!),
    "It has no replies or follow-ups.",
  );
  const doc = researchNode({ id: "doc", type: "document" });
  assert.equal(researchTreeContentsSentence(researchTreeContents([doc], "doc")!), "It has no follow-ups.");
  const question = researchNode({ id: "q" });
  assert.equal(researchTreeContentsSentence(researchTreeContents([question], "q")!), "It has no follow-ups.");
});

test("nodes outside the root's subtree are ignored, and a missing root reads as null", () => {
  const stray = researchNode({ id: "stray", parentNodeId: "elsewhere", inline: true });
  const other = researchNode({ id: "other-root", treeId: "other" });
  assert.deepEqual(researchTreeContents([post, stray, other], "post"), {
    rootType: "post", replies: 2, followUps: 0, branches: 0,
  });
  assert.equal(researchTreeContents([post], "missing"), null);
});

const summary: ResearchTreeSummary = {
  id: "tree", title: "Component-model plugins", rootNodeId: "post", type: "post", workspaceId: "ws",
  runningCount: 0, failedCount: 0, completedCount: 0, cancelledCount: 0, updatedAt: 100,
  hasUnseenUpdate: false, hasUnseenFailure: false,
};

test("the delete offer names the thread, states its contents, and offers Keep and Delete…", () => {
  const contents = researchTreeContents([post, aiFollowUp], "post")!;
  const html = renderOffer(summary, contents);
  assert.match(html, /Delete the original thread\?/);
  assert.match(html, /The original thread, “Component-model plugins”, is unchanged\./);
  assert.match(html, /It has 1 message \(a follow-up\) and 2 replies; deleting the thread also deletes them\./);
  assert.match(html, /<button[^>]*>Keep<\/button>/);
  assert.match(html, /<button[^>]*class="control-button danger"[^>]*>Delete…<\/button>/);
  assert.doesNotMatch(html, /active runs/);
});

test("the delete offer disables Delete… while the thread has active runs", () => {
  const html = renderOffer({ ...summary, runningCount: 1 }, researchTreeContents([post], "post")!);
  assert.match(html, /It has active runs, which must finish or be cancelled before it can be deleted\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Delete…<\/button>/);
});

function renderOffer(tree: ResearchTreeSummary, contents: NonNullable<ReturnType<typeof researchTreeContents>>) {
  return renderToStaticMarkup(
    createElement(ResearchTreeDeleteOfferPanel, { tree, contents, onKeep: () => {}, onDelete: () => {} }),
  );
}

test("messages of one kind say so", () => {
  const question = researchNode({ id: "q" });
  const followUps = [
    researchNode({ id: "q-1", parentNodeId: "q", inline: true }),
    researchNode({ id: "q-2", parentNodeId: "q-1", inline: true }),
  ];
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([question, ...followUps], "q")!),
    "It has 2 messages (all follow-ups); deleting the thread also deletes them.",
  );
  const branch = researchNode({ id: "q-b", parentNodeId: "q" });
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([question, branch], "q")!),
    "It has 1 message (a branch); deleting the thread also deletes it.",
  );
});

