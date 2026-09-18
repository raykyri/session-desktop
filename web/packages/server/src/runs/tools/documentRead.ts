// The owned `document_read` tool (`04-agent-runtime.md` §6, §8).
//
// Gemini, Claude, and Luna receive an attached PDF or image as a file part and
// never need this; DeepSeek has no file input, and every model has a limit on
// what can be inlined. This is the escape hatch for both: the extracted text
// of one attached document, in 30k-character chunks, scoped to the run's
// account so a document id from another user is simply not found.

import { documents as documentsRepo } from "@session/db";
import { tool } from "ai";
import { z } from "zod";

import type { RunToolContext } from "./context.js";

export const DOCUMENT_CHUNK_CHARS = 30_000;

export const DOCUMENT_READ_DESCRIPTION =
  "Read the text of a document attached to this question, by id, in chunks. Call it again " +
  "with the next chunk index while `hasMore` is true.";

export const documentReadInputSchema = z.object({
  documentId: z.string().min(1).describe("Id of an attached document."),
  chunk: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based chunk index; defaults to the first chunk."),
});

export interface DocumentReadOutput {
  documentId: string;
  name?: string;
  chunk: number;
  chunkCount: number;
  hasMore: boolean;
  text: string;
  error?: string;
}

/** Cuts `text` into chunks at a paragraph or word boundary where one is
 * nearby, so a chunk does not end mid-sentence when it does not have to. */
export function chunkDocumentText(text: string, size = DOCUMENT_CHUNK_CHARS): string[] {
  if (text.length <= size) {
    return text === "" ? [] : [text];
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (text.length - offset <= size) {
      chunks.push(text.slice(offset));
      break;
    }
    const window = text.slice(offset, offset + size);
    const paragraph = window.lastIndexOf("\n\n");
    const space = window.lastIndexOf(" ");
    const cut = paragraph > size * 0.5 ? paragraph + 2 : space > size * 0.8 ? space + 1 : size;
    chunks.push(text.slice(offset, offset + cut));
    offset += cut;
  }
  return chunks;
}

/** The whole extracted text of one document: PDF pages are joined with a page
 * marker so a quotation can be traced back to a page. */
export function documentPlainText(ctx: RunToolContext, documentId: string): string {
  const pages = documentsRepo.readText(ctx.db, ctx.userId, documentId);
  if (pages.length <= 1) {
    return pages[0] ?? "";
  }
  return pages.map((page, index) => `[page ${index + 1}]\n${page}`).join("\n\n");
}

export function createDocumentReadTool(ctx: RunToolContext, attachedIds: readonly string[]) {
  const allowed = new Set(attachedIds);
  return tool({
    description: DOCUMENT_READ_DESCRIPTION,
    inputSchema: documentReadInputSchema,
    execute: ({ documentId, chunk = 0 }): DocumentReadOutput => {
      const empty = { documentId, chunk, chunkCount: 0, hasMore: false, text: "" };
      if (!allowed.has(documentId)) {
        return {
          ...empty,
          error: `No document with ID '${documentId}' is attached to this question.`,
        };
      }
      const info = documentsRepo.get(ctx.db, ctx.userId, documentId);
      if (!info) {
        return { ...empty, error: `Document '${documentId}' was not found.` };
      }
      const chunks = chunkDocumentText(documentPlainText(ctx, documentId));
      if (chunks.length === 0) {
        return {
          ...empty,
          name: info.name,
          error: `No text could be extracted from '${info.name}'.`,
        };
      }
      const text = chunks[chunk];
      if (text === undefined) {
        return {
          ...empty,
          name: info.name,
          chunkCount: chunks.length,
          error: `'${info.name}' has ${chunks.length} chunks; requested chunk ${chunk} is out of bounds.`,
        };
      }
      return {
        documentId,
        name: info.name,
        chunk,
        chunkCount: chunks.length,
        hasMore: chunk + 1 < chunks.length,
        text,
      };
    },
  });
}
