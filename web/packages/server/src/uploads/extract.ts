// Text extraction for attached documents (`04-agent-runtime.md` §8).
//
// Extraction is best-effort: a PDF that no parser can read is still a stored
// document that Gemini and Claude receive as a file part, so a failure is
// recorded on the row and never fails the upload.

import type { ExtractionKind } from "./limits.js";

export interface Extraction {
  status: "ok" | "failed";
  /** One entry per page for PDFs, one entry for everything else. */
  pages: string[];
  pageCount: number | null;
  error?: string;
}

async function extractPdf(bytes: Buffer): Promise<Extraction> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const result = await extractText(document, { mergePages: false });
  const pages = result.text.map((page) => page.trim());
  return { status: "ok", pages, pageCount: result.totalPages };
}

async function extractDocx(bytes: Buffer): Promise<Extraction> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: bytes });
  return { status: "ok", pages: [result.value], pageCount: null };
}

export async function extractDocumentText(
  kind: ExtractionKind,
  bytes: Buffer,
): Promise<Extraction> {
  try {
    switch (kind) {
      case "text":
        return { status: "ok", pages: [bytes.toString("utf8")], pageCount: null };
      case "pdf":
        return await extractPdf(bytes);
      case "docx":
        return await extractDocx(bytes);
      case "image":
        // Images carry no text; they reach the model as image parts.
        return { status: "ok", pages: [], pageCount: null };
    }
  } catch (error) {
    return {
      status: "failed",
      pages: [],
      pageCount: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
