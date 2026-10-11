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
// A follow-up note with one stored reply, and an AI follow-up asked about r1
// that continues inline once and has one branch.
const network = researchNode({
  id: "net", type: "post", parentNodeId: "post",
  delivery: { status: "posted", postedAt: 130, replies: [member("n1", 140)] },
});
const aiFollowUp = researchNode({ id: "ai", parentNodeId: "post", anchor: { kind: "reply", replyId: "r1" } });
const aiInline = researchNode({ id: "ai-2", parentNodeId: "ai", inline: true });
const aiBranch = researchNode({ id: "ai-branch", parentNodeId: "ai" });
const networkAi = researchNode({ id: "net-ai", parentNodeId: "net" });

test("a note's stored replies are not counted", () => {
  assert.deepEqual(researchTreeContents([post], "post"), { followUps: 0, branches: 0 });
  assert.equal(researchTreeContentsSentence(researchTreeContents([post], "post")!), "It has no follow-ups.");
});

test("a note's follow-ups are its AI follow-ups and follow-up notes and theirs; passage follow-ups are branches", () => {
  const contents = researchTreeContents(
    [post, network, aiFollowUp, aiInline, aiBranch, networkAi],
    "post",
  );
  assert.deepEqual(contents, { followUps: 4, branches: 1 });
  assert.equal(
    researchTreeContentsSentence(contents!),
    "It has 5 messages (4 follow-ups and 1 branch); deleting the thread also deletes them.",
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
  assert.deepEqual(contents, { followUps: 3, branches: 1 });
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
  assert.deepEqual(contents, { followUps: 1, branches: 2 });
  assert.equal(
    researchTreeContentsSentence(contents!),
    "It has 3 messages (1 follow-up and 2 branches); deleting the thread also deletes them.",
  );
});

test("one item uses singular copy and one message kind is named", () => {
  const bare = researchNode({ id: "post", type: "post", delivery: null });
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([bare, aiFollowUp], "post")!),
    "It has 1 message (a follow-up); deleting the thread also deletes it.",
  );
  assert.equal(
    researchTreeContentsSentence(researchTreeContents([bare, aiFollowUp, aiInline], "post")!),
    "It has 2 messages (all follow-ups); deleting the thread also deletes them.",
  );
});

test("an empty thread has no follow-ups, whatever its root type", () => {
  const bare = researchNode({ id: "post", type: "post", delivery: null });
  assert.equal(researchTreeContentsSentence(researchTreeContents([bare], "post")!), "It has no follow-ups.");
  const doc = researchNode({ id: "doc", type: "document" });
  assert.equal(researchTreeContentsSentence(researchTreeContents([doc], "doc")!), "It has no follow-ups.");
  const question = researchNode({ id: "q" });
  assert.equal(researchTreeContentsSentence(researchTreeContents([question], "q")!), "It has no follow-ups.");
});

test("nodes outside the root's subtree are ignored and a missing root returns null", () => {
  const stray = researchNode({ id: "stray", parentNodeId: "elsewhere", inline: true });
  const other = researchNode({ id: "other-root", treeId: "other" });
  assert.deepEqual(researchTreeContents([post, stray, other], "post"), { followUps: 0, branches: 0 });
  assert.equal(researchTreeContents([post], "missing"), null);
});

const summary: ResearchTreeSummary = {
  id: "tree", title: "Component-model plugins", rootNodeId: "post", type: "post", workspaceId: "ws",
  runningCount: 0, failedCount: 0, completedCount: 0, cancelledCount: 0, updatedAt: 100,
  hasUnseenUpdate: false, hasUnseenFailure: false,
};

test("the delete prompt names the thread, states its contents, and shows Keep and Delete…", () => {
  const contents = researchTreeContents([post, aiFollowUp], "post")!;
  const html = renderOffer(summary, contents);
  assert.match(html, /Delete the original thread\?/);
  assert.match(html, /The original thread, “Component-model plugins”, is unchanged\./);
  assert.match(html, /It has 1 message \(a follow-up\); deleting the thread also deletes it\./);
  assert.doesNotMatch(html, /repl(y|ies)/);
  assert.match(html, /<button[^>]*>Keep<\/button>/);
  assert.match(html, /<button[^>]*class="control-button danger"[^>]*>Delete…<\/button>/);
  assert.doesNotMatch(html, /active runs/);
});

test("the delete prompt disables Delete… while the thread has active runs", () => {
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

