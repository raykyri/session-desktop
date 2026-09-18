// What may be attached to a question (`04-agent-runtime.md` §8).

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_QUESTION = 10;
/** Raised later; documents are kept indefinitely, so this is the only bound. */
export const MAX_DOCUMENT_BYTES_PER_USER = 200 * 1024 * 1024;

export type ExtractionKind = "text" | "pdf" | "docx" | "image";

/** Accepted MIME types and how each one's text is obtained. A type that is not
 * in this table is refused at upload rather than stored and ignored. */
export const ACCEPTED_TYPES: Readonly<Record<string, ExtractionKind>> = {
  "application/pdf": "pdf",
  "text/markdown": "text",
  "text/x-markdown": "text",
  "text/plain": "text",
  "text/csv": "text",
  "application/json": "text",
  "text/json": "text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

/** Extensions for the browsers that send `application/octet-stream` for a
 * Markdown or CSV file. */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** The MIME type to store for an upload: the browser's when we accept it,
 * otherwise the one the file extension implies. */
export function resolveMimeType(reported: string, filename: string): string | null {
  const mime = reported.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime in ACCEPTED_TYPES) {
    return mime;
  }
  const dot = filename.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  return EXTENSION_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}

export function extractionKind(mime: string): ExtractionKind | null {
  return ACCEPTED_TYPES[mime] ?? null;
}
