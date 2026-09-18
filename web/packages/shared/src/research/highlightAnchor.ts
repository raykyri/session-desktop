// Highlight anchor validation and the storage accounting behind the highlight
// caps.
//
// Ported from `validate_highlight_anchor`, `highlight_storage_bytes`,
// `highlight_collection_storage_bytes` and `validate_highlight_collection` in
// `src-tauri/src/research.rs:1522-1590`; the caps are
// `02-domain-model-and-database.md` §5.5.
//
// Two different length units are in play and both are load-bearing:
//
//   - `start` and `end` are offsets into the `answer-v1` projection in UTF-16
//     code units, the unit a browser's Selection API reports, so
//     `end - start` is compared against `exact.length`;
//   - every size cap counts UTF-8 bytes, because the caps bound what is
//     stored and transferred, and because that is what the desktop's
//     `str::len()` measured.
//
// The error messages are shown to the user verbatim, so they are kept
// unchanged from the desktop.

import type { ResearchHighlight, ResearchHighlightAnchor } from "../types/research.js";

import { isResponseRevision } from "./revision.js";

/** Cap on a stored response snapshot, in UTF-8 bytes. An anchor offset past
 * it cannot address anything in a real answer. */
export const MAX_RESPONSE_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** Cap on the selected text of one highlight, in UTF-8 bytes. */
export const MAX_HIGHLIGHT_EXACT_BYTES = 64 * 1024;

/** Cap on each context string captured with a highlight, in UTF-8 bytes. */
export const MAX_HIGHLIGHT_CONTEXT_BYTES = 512;

export const MAX_RESEARCH_HIGHLIGHTS_PER_NODE = 500;

export const MAX_RESEARCH_HIGHLIGHT_BYTES_PER_NODE = 512 * 1024;

/** Cap on one user's highlight data across every node. The desktop measured
 * this per state file, which was one workspace on one machine. */
export const MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL = 4 * 1024 * 1024;

const UTF8 = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Checks an anchor on its own: shape, offsets, and sizes. It does not check
 * that the anchor still describes the node's current answer — that is the
 * snapshot revision comparison the repository does, which reports "the
 * research response changed; select the text again".
 *
 * Throws with a message meant for the user.
 */
export function validateHighlightAnchor(anchor: ResearchHighlightAnchor): void {
  if (anchor.version !== 1 || anchor.projection !== "answer-v1") {
    throw new Error("unsupported research highlight anchor");
  }
  if (anchor.start >= anchor.end || anchor.exact.trim() === "") {
    throw new Error("research highlight selection cannot be empty");
  }
  // `exact.length` is a UTF-16 code-unit count, the same unit as the offsets.
  if (
    anchor.end > MAX_RESPONSE_SNAPSHOT_BYTES ||
    anchor.end - anchor.start !== anchor.exact.length
  ) {
    throw new Error("research highlight has invalid selection offsets");
  }
  if (
    utf8ByteLength(anchor.exact) > MAX_HIGHLIGHT_EXACT_BYTES ||
    utf8ByteLength(anchor.prefix) > MAX_HIGHLIGHT_CONTEXT_BYTES ||
    utf8ByteLength(anchor.suffix) > MAX_HIGHLIGHT_CONTEXT_BYTES
  ) {
    throw new Error("research highlight selection is too large");
  }
  // The desktop accepted either case here because it only ever compared the
  // revision against one it had written; the web takes anchors from clients,
  // so the check is the exact form `responseRevision` emits.
  if (!isResponseRevision(anchor.responseRevision)) {
    throw new Error("research highlight has an invalid response revision");
  }
}

/**
 * Storage charged for one highlight. Includes a conservative allowance for
 * JSON field names, numeric values, escaping, and collection punctuation in
 * addition to the stored strings: a control character can expand to a
 * six-byte JSON escape, and using the worst case keeps the cap authoritative
 * without serializing the whole row on every insertion.
 */
export function highlightStorageBytes(highlight: ResearchHighlight): number {
  return (
    160 +
    utf8ByteLength(highlight.id) +
    utf8ByteLength(highlight.anchor.projection) +
    utf8ByteLength(highlight.anchor.responseRevision) +
    6 * utf8ByteLength(highlight.anchor.exact) +
    6 * utf8ByteLength(highlight.anchor.prefix) +
    6 * utf8ByteLength(highlight.anchor.suffix)
  );
}

export function highlightCollectionStorageBytes(highlights: readonly ResearchHighlight[]): number {
  return highlights.reduce((total, highlight) => total + highlightStorageBytes(highlight), 0);
}

/**
 * Checks a node's whole highlight set: count, unique non-empty ids, every
 * anchor, and the per-node storage cap. The flat 160-byte overhead makes the
 * byte cap bind before the count cap for all but the shortest selections.
 */
export function validateHighlightCollection(highlights: readonly ResearchHighlight[]): void {
  if (highlights.length > MAX_RESEARCH_HIGHLIGHTS_PER_NODE) {
    throw new Error(
      `a research answer can have at most ${MAX_RESEARCH_HIGHLIGHTS_PER_NODE} highlights`,
    );
  }
  const ids = new Set<string>();
  for (const highlight of highlights) {
    if (highlight.id === "" || ids.has(highlight.id)) {
      throw new Error("research highlights must have unique non-empty ids");
    }
    ids.add(highlight.id);
    validateHighlightAnchor(highlight.anchor);
  }
  if (highlightCollectionStorageBytes(highlights) > MAX_RESEARCH_HIGHLIGHT_BYTES_PER_NODE) {
    throw new Error("a research answer contains too much highlight data");
  }
}

/**
 * Checks one user's total highlight storage before an insertion.
 * `existingBytes` is {@link highlightCollectionStorageBytes} over everything
 * the user has saved. The desktop said "session contains too much…" because
 * the budget belonged to a state file; on the web it belongs to an account.
 */
export function validateHighlightBudget(existingBytes: number, added: ResearchHighlight): void {
  if (existingBytes + highlightStorageBytes(added) > MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL) {
    throw new Error("your account contains too much saved research highlight data");
  }
}
