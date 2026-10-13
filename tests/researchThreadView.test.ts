import assert from "node:assert/strict";
import test from "node:test";
import {
  researchBranchBlocker,
  researchBranchStates,
  researchChainComposerState,
  researchDeleteLabel,
  researchEditorCanSave,
  researchEditorSessionSaved,
  researchEditorStats,
  researchMarkerLabel,
  researchNodeLabel,
  researchQuoteText,
  researchSubtreeIds,
  sameIds,
  sameNumberRecord,
  surrogateSafeSlice,
  withoutKeys,
} from "../src/lib/researchThreadView";
import { researchBranchesByParent } from "../src/lib/researchBranchView";
import { buildSegmentView, TIMELINE_ITEM_RENDER_WINDOW } from "../src/lib/researchSegmentView";
import { RESEARCH_DOCUMENT_WORD_LIMIT } from "../src/lib/researchDocuments";
import type { ResearchHighlightAnchor, ResearchNode, Turn } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

function node(id: string, overrides: NodeFixture = {}): ResearchNode {
  return researchNode({ id, prompt: id, status: "complete", sessionReady: true, ...overrides });
}

function turn(index: number, role: "user" | "assistant", text: string): Turn {
  return { id: `t-${index}`, agentId: "agent", role, blocks: [{ type: "text", text }], sourceIndex: index };
}

function anchor(exact: string): ResearchHighlightAnchor {
  return { version: 1, projection: "answer-v1", responseRevision: "rev", start: 0, end: exact.length, exact, prefix: "", suffix: "" };
}

test("withoutKeys keeps the record's identity when no key is present", () => {
  const record = { a: 1, b: 2 };
  assert.equal(withoutKeys(record, ["c"]), record);
  assert.deepEqual(withoutKeys(record, ["a", "c"]), { b: 2 });
  assert.deepEqual(record, { a: 1, b: 2 });
});

test("sameIds and sameNumberRecord compare by value", () => {
  assert.equal(sameIds(["a", "b"], ["a", "b"]), true);
  assert.equal(sameIds(["a", "b"], ["b", "a"]), false);
  assert.equal(sameIds(["a"], ["a", "b"]), false);
  assert.equal(sameNumberRecord({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameNumberRecord({ a: 1 }, { a: 2 }), false);
  assert.equal(sameNumberRecord({ a: 1 }, { a: 1, b: 0 }), false);
});

test("researchNodeLabel prefers the title, then the question, then the fallback", () => {
  assert.equal(researchNodeLabel(node("n", { title: " Title ", prompt: "Question" }), "Branch"), "Title");
  assert.equal(researchNodeLabel(node("n", { prompt: "Question" }), "Branch"), "Question");
  assert.equal(researchNodeLabel(node("n", { prompt: "  " }), "Branch"), "Branch");
  assert.equal(researchNodeLabel(undefined, "Branch"), "Branch");
});

test("researchBranchBlocker names why a branch cannot start", () => {
  assert.equal(researchBranchBlocker(node("n"), false), null);
  assert.match(researchBranchBlocker(node("n"), true) ?? "", /Archive/);
  assert.equal(researchBranchBlocker(null, false), "Wait for the answer to finish");
  assert.equal(researchBranchBlocker(node("n", { status: "running" }), false), "Wait for the answer to finish");
  assert.match(researchBranchBlocker(node("n", { status: "failed" }), false) ?? "", /error/);
  assert.match(researchBranchBlocker(node("n", { status: "cancelled" }), false) ?? "", /stopped/);
  assert.equal(
    researchBranchBlocker(node("n", { sessionReady: false }), false),
    "Waiting for the native session checkpoint",
  );
});

test("researchQuoteText collapses whitespace to one line", () => {
  assert.equal(researchQuoteText("  one\n\ntwo\tthree "), "one two three");
});

test("surrogateSafeSlice clamps and never splits a surrogate pair", () => {
  const text = "a😀b";
  assert.equal(surrogateSafeSlice(text, 2, 4), "😀b");
  assert.equal(surrogateSafeSlice(text, 0, 2), "a😀");
  assert.equal(surrogateSafeSlice(text, -3, 99), text);
  assert.equal(surrogateSafeSlice("plain", 1, 3), "la");
});

test("researchSubtreeIds and a branch's state cover every descendant", () => {
  const nodes = [
    node("root"),
    node("a", { parentNodeId: "root" }),
    node("a1", { parentNodeId: "a" }),
    node("b", { parentNodeId: "root" }),
    node("a2", { parentNodeId: "a1", status: "running" }),
  ];
  assert.deepEqual([...researchSubtreeIds(nodes, "a")].sort(), ["a", "a1", "a2"]);
  assert.deepEqual([...researchSubtreeIds(nodes, "b")], ["b"]);
  const { ofBranch } = researchBranchStates(nodes, researchBranchesByParent(nodes));
  assert.equal(ofBranch("a"), "running");
  assert.equal(ofBranch("b"), null);
  assert.equal(ofBranch("missing"), null);
});

test("researchDeleteLabel names what the deletion takes", () => {
  assert.equal(researchDeleteLabel(true, false, 3), "Delete research");
  assert.equal(researchDeleteLabel(false, true, 2), "Delete from here");
  assert.equal(researchDeleteLabel(false, false, 2), "Delete branch");
  assert.equal(researchDeleteLabel(false, true, 0), "Delete follow-up");
  assert.equal(researchDeleteLabel(false, false, 0), "Delete follow-up");
});

test("researchEditorStats counts a document's words and unmatched anchors", () => {
  const session = {
    kind: "document" as const,
    initialText: "Alpha beta gamma",
    highlightAnchors: [anchor("beta")],
    branchAnchors: [anchor("gamma")],
  };
  assert.deepEqual(researchEditorStats(session, "Alpha beta gamma"), {
    wordCount: 3,
    overWordLimit: false,
    overByteLimit: false,
    removedHighlights: 0,
    unmatchedBranches: 0,
  });
  const edited = researchEditorStats(session, "Alpha delta");
  assert.equal(edited.wordCount, 2);
  assert.equal(edited.removedHighlights, 1);
  assert.equal(edited.unmatchedBranches, 1);
  const long = researchEditorStats(session, "word ".repeat(RESEARCH_DOCUMENT_WORD_LIMIT + 1));
  assert.equal(long.overWordLimit, true);
  assert.ok(long.wordCount > RESEARCH_DOCUMENT_WORD_LIMIT);
});

test("researchEditorStats counts only highlights for a note", () => {
  const stats = researchEditorStats(
    { kind: "post", initialText: "Alpha beta", highlightAnchors: [anchor("beta")], branchAnchors: [anchor("Alpha")] },
    "gamma",
  );
  assert.deepEqual(stats, {
    wordCount: 0,
    overWordLimit: false,
    overByteLimit: false,
    removedHighlights: 1,
    unmatchedBranches: 0,
  });
});

test("buildSegmentView windows a run's newest timeline items", () => {
  const turns: Turn[] = [];
  for (let index = 0; index < TIMELINE_ITEM_RENDER_WINDOW + 20; index += 1) {
    turns.push(turn(index * 2, "user", `question ${index}`), turn(index * 2 + 1, "assistant", `answer ${index}`));
  }
  const exchange = node("n");
  const view = buildSegmentView(exchange, { node: exchange, turns }, false, false);
  assert.equal(view.isConversation, false);
  assert.equal(view.visibleTimelineItems.length, Math.min(TIMELINE_ITEM_RENDER_WINDOW, view.displayedTimelineItems.length));
  assert.equal(view.hiddenTimelineItemCount, view.displayedTimelineItems.length - view.visibleTimelineItems.length);
  if (view.hiddenTimelineItemCount > 0) {
    assert.equal(view.visibleTimelineItems[view.visibleTimelineItems.length - 1], view.displayedTimelineItems[view.displayedTimelineItems.length - 1]);
  }
  const all = buildSegmentView(exchange, { node: exchange, turns }, true, false);
  assert.equal(all.hiddenTimelineItemCount, 0);
  assert.equal(all.editableDocumentMarkdown, null);
});

test("buildSegmentView reads a transcript as a conversation and a document's Markdown", () => {
  const transcript = node("t", { type: "document", source: "transcript" });
  const turns = [turn(0, "user", "Hello"), turn(1, "assistant", "Hi there")];
  const conversation = buildSegmentView(transcript, { node: transcript, turns }, false, false);
  assert.equal(conversation.isConversation, true);
  assert.equal(conversation.hasTranscriptActivity, false);
  assert.match(conversation.conversationCopyText ?? "", /Hi there/);
  assert.equal(conversation.editableDocumentMarkdown, null);

  const authored = node("d", { type: "document", source: "authored" });
  const document = buildSegmentView(authored, { node: authored, turns: [turn(0, "assistant", "Title\n\nBody text")] }, false, false);
  assert.equal(document.editableDocumentMarkdown, "Title\n\nBody text");
  assert.equal(document.answerWordCount, 3);

  const loading = buildSegmentView(authored, null, false, false);
  assert.equal(loading.content, null);
  assert.equal(loading.timelineItems.length, 0);
});

test("researchEditorCanSave needs a changed, non-empty note", () => {
  const note = { kind: "post" as const, initialText: "Old", text: "Old ", title: "", initialTitle: "" };
  assert.equal(researchEditorCanSave(note, null), false);
  assert.equal(researchEditorCanSave({ ...note, text: "  " }, null), false);
  assert.equal(researchEditorCanSave({ ...note, text: "New" }, null), true);
});

test("researchEditorCanSave applies the document gate", () => {
  const document = { kind: "document" as const, initialText: "Body", text: "Body", title: "T", initialTitle: "T" };
  assert.equal(researchEditorCanSave(document, null), false);
  assert.equal(researchEditorCanSave({ ...document, title: "U" }, null), true);
  assert.equal(researchEditorCanSave({ ...document, text: "Edited" }, { overWordLimit: false, overByteLimit: false }), true);
  assert.equal(researchEditorCanSave({ ...document, text: "Edited" }, { overWordLimit: true, overByteLimit: false }), false);
  // Over the limit, the title alone can still change.
  assert.equal(researchEditorCanSave({ ...document, title: "U" }, { overWordLimit: true, overByteLimit: false }), true);
});

test("researchEditorSessionSaved makes the saved field values the initial ones and expects what was stored", () => {
  const document = {
    nodeId: "d",
    kind: "document" as const,
    initialText: "Body",
    text: "  Body edited\n",
    initialTitle: "Old title",
    title: "",
    expectedText: "Body",
    expectedTitle: "Old title",
    responseRevision: "rev-1",
    highlightIds: ["h1", "h2"],
    highlightAnchors: [anchor("Body"), anchor("gone")],
  };
  const kept = { id: "h1", anchor: anchor("Body"), createdAt: 1 };
  const next = researchEditorSessionSaved(
    // Typed while the save ran.
    { ...document, text: "  Body edited\nMore" },
    { text: document.text, title: document.title },
    { tree: { title: "Body edited" }, node: node("d", { type: "document", highlights: [kept] }), responseRevision: "rev-2" },
  );
  assert.equal(next.initialText, "  Body edited\n");
  assert.equal(next.text, "  Body edited\nMore");
  // A blank title stays blank in the field; the next save expects the title
  // the backend derived.
  assert.equal(next.initialTitle, "");
  assert.equal(next.title, "");
  assert.equal(next.expectedTitle, "Body edited");
  assert.equal(next.responseRevision, "rev-2");
  assert.deepEqual(next.highlightIds, ["h1"]);
  assert.deepEqual(next.highlightAnchors, [kept.anchor]);
  assert.equal(next.nodeId, "d");

  const note = {
    ...document,
    nodeId: "p",
    kind: "post" as const,
    initialText: "Old",
    text: "New text \n",
    initialTitle: "",
    title: "",
    expectedText: "Old",
    expectedTitle: "",
    responseRevision: null,
    highlightIds: [],
    highlightAnchors: [],
  };
  const savedNote = researchEditorSessionSaved(
    note,
    { text: note.text, title: note.title },
    { tree: { title: "New text" }, node: node("p", { type: "post", prompt: "New text" }) },
  );
  // The field keeps its trailing whitespace and reads as unchanged; the next
  // save expects the trimmed stored text.
  assert.equal(savedNote.initialText, "New text \n");
  assert.equal(savedNote.expectedText, "New text");
  assert.equal(savedNote.expectedTitle, "");
  assert.equal(savedNote.responseRevision, null);
  assert.equal(researchEditorCanSave(savedNote, null), false);
});

test("researchChainComposerState continues, queues, or explains a stalled chain", () => {
  const settled = node("head");
  assert.deepEqual(
    researchChainComposerState({ nodes: [settled], chain: [settled], editing: false, queued: false, archived: false }),
    { canSend: true, disabled: false, note: null, placeholder: "Ask a follow-up" },
  );

  const running = node("head", { status: "running" });
  const busy = researchChainComposerState({ nodes: [running], chain: [running], editing: false, queued: false, archived: false });
  assert.equal(busy.canSend, true);
  assert.equal(busy.placeholder, "Queue a follow-up");

  const failed = node("head", { status: "failed" });
  const stalled = researchChainComposerState({ nodes: [failed], chain: [failed], editing: false, queued: false, archived: false });
  assert.equal(stalled.disabled, true);
  assert.match(stalled.note ?? "", /stopped with an error/);
  assert.deepEqual(
    researchChainComposerState({ nodes: [failed], chain: [failed], editing: true, queued: false, archived: false }),
    { canSend: true, disabled: false, note: null, placeholder: "Edit the question" },
  );

  const archived = researchChainComposerState({ nodes: [settled], chain: [settled], editing: false, queued: false, archived: true });
  assert.equal(archived.canSend, false);
  assert.equal(archived.disabled, true);
  assert.match(archived.note ?? "", /Archive/);

  const unready = node("head", { sessionReady: false });
  assert.equal(
    researchChainComposerState({ nodes: [unready], chain: [unready], editing: false, queued: false, archived: false }).note,
    "Waiting for the native session checkpoint before continuing.",
  );
});

test("researchMarkerLabel names the branches and what a click does", () => {
  assert.equal(
    researchMarkerLabel({ count: 1, whole: false, open: false, state: null, targetPrompt: "Why\n  this?" }),
    "1 branch from this paragraph. Opens: Why this?",
  );
  assert.equal(
    researchMarkerLabel({ count: 3, whole: true, open: true, state: "running", targetPrompt: "x" }),
    "3 branches from the whole answer, one is open, running. Closes it.",
  );
  assert.equal(
    researchMarkerLabel({ count: 1, whole: true, open: false, state: "running", targetPrompt: "q".repeat(100) }),
    `1 branch from the whole answer, running. Opens: ${"q".repeat(80)}`,
  );
  assert.equal(
    researchMarkerLabel({ count: 2, whole: false, open: false, state: "failed", targetPrompt: "y" }),
    "2 branches from this paragraph, failed. Opens: y",
  );
});

test("a message's branch state is failed, else running, from anywhere in its branches", () => {
  const nodes = [
    node("root"),
    node("next", { parentNodeId: "root", inline: true, status: "running" }),
    node("b1", { parentNodeId: "root" }),
    node("b1f", { parentNodeId: "b1", inline: true }),
    node("deep", { parentNodeId: "b1f", status: "running" }),
    node("b2", { parentNodeId: "root", status: "failed" }),
    node("c1", { parentNodeId: "b1f" }),
    node("settled", { parentNodeId: "c1" }),
  ];
  const { ofMessage: states, ofBranch } = researchBranchStates(nodes, researchBranchesByParent(nodes));
  // root's branches hold a failed message (b2) and a running one (deep).
  assert.equal(states.get("root"), "failed");
  // b1f's branches: deep runs.
  assert.equal(states.get("b1f"), "running");
  // c1's only branch is settled; the inline follow-up of root is not a branch.
  assert.equal(states.has("c1"), false);
  assert.equal(states.has("next"), false);
  // One branch: b1 (with b1f and the branches below it) runs.
  assert.equal(ofBranch("b1"), "running");
  assert.equal(ofBranch("c1"), null);
  assert.equal(ofBranch("missing"), null);
});

test("a branch's state is failed over running, however deep the failed message is", () => {
  const nodes = [
    node("root"),
    node("b1", { parentNodeId: "root", status: "running" }),
    node("b1f", { parentNodeId: "b1", inline: true }),
    node("c1", { parentNodeId: "b1f" }),
    node("c1f", { parentNodeId: "c1", inline: true }),
    node("d1", { parentNodeId: "c1f", status: "failed" }),
    node("b2", { parentNodeId: "root", status: "queued" }),
  ];
  const { ofMessage, ofBranch } = researchBranchStates(nodes, researchBranchesByParent(nodes));
  // b1 runs, and a message three levels below it failed.
  assert.equal(ofBranch("b1"), "failed");
  assert.equal(ofBranch("c1"), "failed");
  assert.equal(ofBranch("d1"), "failed");
  // A queued branch counts as running.
  assert.equal(ofBranch("b2"), "running");
  assert.equal(ofMessage.get("root"), "failed");
  assert.equal(ofMessage.get("b1f"), "failed");
  assert.equal(ofMessage.get("c1f"), "failed");
});

test("a branch's state ends at a malformed parent cycle", () => {
  // a and b name each other as parent; neither is reached from the root.
  const nodes = [
    node("root"),
    node("a", { parentNodeId: "b", status: "running" }),
    node("b", { parentNodeId: "a" }),
    node("c", { parentNodeId: "b", status: "failed" }),
  ];
  const { ofMessage, ofBranch } = researchBranchStates(nodes, researchBranchesByParent(nodes));
  assert.equal(ofBranch("a"), "failed");
  assert.equal(ofBranch("b"), "failed");
  assert.equal(ofMessage.get("a"), "failed");
  assert.equal(ofMessage.get("b"), "failed");
  assert.equal(ofBranch("root"), null);
});
