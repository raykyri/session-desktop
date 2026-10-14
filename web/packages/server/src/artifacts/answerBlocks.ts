// The widget blocks of a stored answer. The answer text is the only source
// of widget HTML the server serves or records: a client names a block (by its
// hash, or by its HTML and fence metadata), and the server looks for it here.

import { createHash } from "node:crypto";

import {
  MAX_SESSION_WIDGET_BYTES,
  baseRemarkPlugins,
  buildTimelineItems,
  collapseImageMarkers,
  escapeWikilinkTablePipes,
  fencedBlockIsClosed,
  isSessionWidgetInfo,
  normalizeLatexMathDelimiters,
  type ResearchNodeContent,
  type WidgetMarkdownNode,
} from "@session/shared";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** One complete `session-html` block: its HTML and the fence's metadata
 * (the opening line after `session-html`, trimmed), as the client's
 * `remarkSessionWidgetFences` reports them. */
export interface AnswerWidgetBlock {
  html: string;
  meta: string;
  /** Where the fence starts in the text it was found in. */
  offset: number;
}

const widgetMarkdown = unified().use(remarkParse).use(baseRemarkPlugins);

function completeWidgetBlocks(source: string): AnswerWidgetBlock[] {
  const found: AnswerWidgetBlock[] = [];
  const visit = (node: WidgetMarkdownNode) => {
    if (node.type === "code" && isSessionWidgetInfo(node.lang)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const value = node.value ?? "";
      if (
        start !== undefined &&
        end !== undefined &&
        fencedBlockIsClosed(source.slice(start, end), value) &&
        Buffer.byteLength(value, "utf8") <= MAX_SESSION_WIDGET_BYTES
      ) {
        const opening = source.slice(start, end).split(/\r?\n/u)[0] ?? "";
        const meta = opening.includes("session-html")
          ? opening.slice(opening.indexOf("session-html") + "session-html".length).trim()
          : (node.meta ?? "");
        found.push({ html: value, meta, offset: start });
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(widgetMarkdown.runSync(widgetMarkdown.parse(source), source));
  return found;
}

/** The assistant text of an answer as the client renders it: each turn's
 * text blocks, the merged timeline messages and the text still streaming. */
function answerTexts(content: ResearchNodeContent): Set<string> {
  const texts = new Set<string>();
  for (const turn of content.turns)
    if (turn.role === "assistant")
      for (const block of turn.blocks) if (block.type === "text") texts.add(block.text);
  for (const item of buildTimelineItems(content.turns))
    if (item.role === "assistant")
      for (const block of item.blocks) if (block.type === "text") texts.add(block.text);
  if (content.inFlightText) texts.add(content.inFlightText);
  return texts;
}

/**
 * Every complete widget block in a stored answer, parsed with the client's
 * Markdown plugins and pre-parse rewrites so a block the client renders is
 * found. `mustInclude` skips texts that cannot hold the wanted block.
 */
export function answerWidgetBlocks(
  content: ResearchNodeContent,
  mustInclude?: string,
): AnswerWidgetBlock[] {
  const blocks = new Map<string, AnswerWidgetBlock>();
  for (const text of answerTexts(content)) {
    if (!text.includes("session-html")) continue;
    if (mustInclude !== undefined && !text.includes(mustInclude)) continue;
    const prepared = escapeWikilinkTablePipes(collapseImageMarkers(text));
    for (const source of new Set([text, prepared, normalizeLatexMathDelimiters(prepared)]))
      for (const block of completeWidgetBlocks(source))
        blocks.set(JSON.stringify([block.html, block.meta]), block);
  }
  return [...blocks.values()];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The widget block in a stored answer whose HTML has this SHA-256, or null. */
export function answerWidgetSource(content: ResearchNodeContent, sha256: string): string | null {
  return (
    answerWidgetBlocks(content).find((block) => sha256Hex(block.html) === sha256)?.html ?? null
  );
}

/** CRLF and LF sources are the same widget (`repos/widgets.ts`). */
export function normalizeWidgetHtml(html: string): string {
  return html.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}
