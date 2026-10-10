// Rules for the editor column (ResearchEditorColumn): which blocks of an
// edited text changed, whether a post's edit replaces its text or adds a
// correction, and whether the text can be asked as a question.

import { closesFence, markerRunAtLineStart, type MarkdownFence } from "./markdownMathDelimiters";
import { nodeType } from "./researchNodeTypes";
import type { ResearchNode } from "../types";

/** The longest text, in characters after trimming, that "Ask as a question"
 * sends as a question. */
export const QUESTION_CHARACTER_LIMIT = 500;

/** The trimmed text's length in characters (code points), and whether it
 * can be asked as a question. */
export function researchQuestionLength(text: string): { count: number; allowed: boolean } {
  const trimmed = text.trim();
  let count = 0;
  for (const _ of trimmed) count += 1;
  return { count, allowed: count > 0 && count <= QUESTION_CHARACTER_LIMIT };
}

/** Splits Markdown into blocks at blank lines, keeping a fenced code block
 * (and its blank lines) in one block. Each block is trimmed; empty blocks are
 * dropped. */
export function markdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: MarkdownFence | null = null;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) blocks.push(text);
    current = [];
  };
  for (const line of markdown.split("\n")) {
    if (fence) {
      current.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = markerRunAtLineStart(line);
    if (opening) {
      fence = opening;
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

interface EditedBlock {
  text: string;
  /** The block is not in the original text (new, or changed). */
  changed: boolean;
}

/** The blocks of `next`, each marked changed when the original text has no
 * identical block left to pair it with. */
export function editedMarkdownBlocks(original: string, next: string): EditedBlock[] {
  const remaining = new Map<string, number>();
  for (const block of markdownBlocks(original)) {
    remaining.set(block, (remaining.get(block) ?? 0) + 1);
  }
  return markdownBlocks(next).map((text) => {
    const left = remaining.get(text) ?? 0;
    if (left > 0) {
      remaining.set(text, left - 1);
      return { text, changed: false };
    }
    return { text, changed: true };
  });
}

/** Whether a post has replies or follow-ups, so that an edit appends a
 * correction instead of replacing its text. Mirrors update_research_note. */
export function researchPostHasReplies(nodes: readonly ResearchNode[], post: ResearchNode): boolean {
  return (
    (post.delivery?.replies?.length ?? 0) > 0 ||
    nodes.some((node) => node.parentNodeId === post.id && nodeType(node) !== "document")
  );
}
