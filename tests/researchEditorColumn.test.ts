import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchEditorColumn, ResearchEditPreview } from "../src/components/research/ResearchEditorColumn";
import {
  QUESTION_CHARACTER_LIMIT,
  editedMarkdownBlocks,
  markdownBlocks,
  researchPostHasReplies,
  researchQuestionLength,
} from "../src/lib/researchEditor";
import type { ResearchNode } from "../src/types";

function node(id: string, overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id,
    treeId: "tree",
    prompt: id,
    adapter: "claude",
    groupId: "ws",
    worktreeDir: "/ws",
    status: "complete",
    createdAt: 0,
    highlights: [],
    ...overrides,
  };
}

function editor(value: string, overrides: Partial<Parameters<typeof ResearchEditorColumn>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ResearchEditorColumn, {
      column: { id: "E0", role: "editor", levelIndex: 0, nodeId: "note" },
      current: true,
      kind: "post",
      correction: false,
      value,
      onChange: () => {},
      dirty: false,
      canSave: false,
      saving: false,
      notices: null,
      error: null,
      questionModel: "Claude Opus",
      asking: false,
      textareaRef: null,
      onCancel: () => {},
      onSave: () => {},
      onAskAsQuestion: () => {},
      ...overrides,
    }),
  );
}

test("a question is up to 500 characters after trimming", () => {
  assert.equal(QUESTION_CHARACTER_LIMIT, 500);
  assert.deepEqual(researchQuestionLength(`  ${"a".repeat(500)}\n`), { count: 500, allowed: true });
  assert.deepEqual(researchQuestionLength("a".repeat(501)), { count: 501, allowed: false });
  assert.deepEqual(researchQuestionLength("   "), { count: 0, allowed: false });
  // Characters are code points: an emoji counts once.
  assert.deepEqual(researchQuestionLength("😀".repeat(500)), { count: 500, allowed: true });
});

test("Ask as a question is enabled within the limit and names the model", () => {
  const html = editor("How do mods work?");
  assert.match(html, /Ask as a question/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.match(html, /Asks Claude Opus/);
  assert.match(html, /aria-label="Edit post"/);
  assert.match(html, />Save</);
});

test("over the limit, Ask as a question stays visible but disabled with the count as its description", () => {
  const html = editor("x".repeat(612));
  const button = /<button[^>]*research-editor-ask[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(button, /aria-disabled="true"/);
  const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
  assert.ok(describedBy);
  assert.match(html, new RegExp(`id="${describedBy}"[^>]*>612 / 500 characters<`));
});

test("a post with replies is corrected: the button reads Add correction", () => {
  const html = editor("Corrected text", { correction: true });
  assert.match(html, /aria-label="Correct post"/);
  assert.match(html, /Add correction/);
});

test("a post has replies when it has reply items or follow-ups", () => {
  const post = node("note", { kind: "note", delivery: { status: "posted", postedAt: 1 } });
  assert.equal(researchPostHasReplies([post], post), false);
  const replied = {
    ...post,
    delivery: {
      status: "posted" as const,
      postedAt: 1,
      replies: [{ id: "r", author: { kind: "author" as const }, body: "hi", createdAt: 2 }],
    },
  };
  assert.equal(researchPostHasReplies([replied], replied), true);
  assert.equal(researchPostHasReplies([post, node("run", { parentNodeId: "note" })], post), true);
});

test("Markdown splits into blocks at blank lines outside code fences", () => {
  assert.deepEqual(markdownBlocks("# Title\n\nOne\ntwo\n\n\n```\na\n\nb\n```\n\nEnd"), [
    "# Title",
    "One\ntwo",
    "```\na\n\nb\n```",
    "End",
  ]);
});

test("the preview marks blocks that are not in the saved text", () => {
  assert.deepEqual(editedMarkdownBlocks("A\n\nB\n\nB", "A\n\nB changed\n\nB\n\nNew"), [
    { text: "A", changed: false },
    { text: "B changed", changed: true },
    { text: "B", changed: false },
    { text: "New", changed: true },
  ]);
  const html = renderToStaticMarkup(
    createElement(ResearchEditPreview, { original: "Same\n\nOld", next: "Same\n\nNew", label: "Preview" }),
  );
  assert.match(html, /Preview · 1 paragraph changed/);
  assert.equal(html.match(/research-edit-block is-changed/g)?.length, 1);
});
