// Client-side mirror of src-tauri/src/research_anchors.rs: where a highlight
// or branch anchor goes when a document's Markdown or a post's text is
// replaced. The editor uses it to state, before Save, how many highlights the
// backend will remove. The backend remains authoritative; both sides pin the
// shared cases in tests (tests/researchAnchors.test.ts and the Rust module's
// tests).
//
// Only letters and digits are compared, so Markdown syntax around a rendered
// quote does not prevent a match. In one text: every occurrence of the quote
// is a candidate; candidates whose prefix and suffix both agree (the last and
// first CONTEXT_CHARS characters of each side) win, nearest the expected
// offset first; otherwise a single candidate that keeps one side; otherwise no
// match. A quote with no match in the old text is left unchanged; one that
// matches in the old text but not in the new one no longer matches.

import type { ResearchHighlightAnchor } from "../types";

/** Characters of normalized context compared on each side of a quote. */
export const RESEARCH_ANCHOR_CONTEXT_CHARS = 32;

export type ResearchAnchorOutcome =
  | { kind: "unchanged" }
  | { kind: "moved"; start: number; end: number }
  | { kind: "unmatched" };

type AnchorQuote = Pick<ResearchHighlightAnchor, "exact" | "prefix" | "suffix" | "start" | "end">;

// Rust's char::is_alphanumeric: the Alphabetic property or a Number category.
const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;

interface NormalizedText {
  text: string;
  /** For each UTF-16 unit of `text`, the UTF-16 offset in the source of the
   * code point it belongs to. */
  offsets: Uint32Array;
}

function normalizeWithOffsets(source: string): NormalizedText {
  const parts: string[] = [];
  const offsets = new Uint32Array(source.length);
  let length = 0;
  let offset = 0;
  for (const character of source) {
    if (ALPHANUMERIC.test(character)) {
      parts.push(character);
      for (let unit = 0; unit < character.length; unit += 1) {
        offsets[length] = offset;
        length += 1;
      }
    }
    offset += character.length;
  }
  return { text: parts.join(""), offsets: offsets.subarray(0, length) };
}

function normalize(text: string): string {
  let result = "";
  for (const character of text) {
    if (ALPHANUMERIC.test(character)) result += character;
  }
  return result;
}

function lastCodePoints(text: string, count: number): string {
  const points = [...text];
  return points.slice(Math.max(0, points.length - count)).join("");
}

function firstCodePoints(text: string, count: number): string {
  return [...text].slice(0, count).join("");
}

function locate(
  haystack: NormalizedText,
  quote: string,
  prefix: string,
  suffix: string,
  near: number,
): number | null {
  const text = haystack.text;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let loose: number | null = null;
  let looseCount = 0;
  let at = text.indexOf(quote);
  while (at >= 0) {
    const prefixMatches = !prefix || (at >= prefix.length && text.slice(at - prefix.length, at) === prefix);
    const suffixMatches = !suffix || text.startsWith(suffix, at + quote.length);
    const offset = haystack.offsets[at];
    if (prefixMatches && suffixMatches) {
      const distance = Math.abs(offset - near);
      if (distance < bestDistance) {
        best = offset;
        bestDistance = distance;
      }
    } else if (prefixMatches || suffixMatches) {
      loose = offset;
      looseCount += 1;
    }
    const code = text.codePointAt(at) ?? 0;
    at = text.indexOf(quote, at + (code > 0xffff ? 2 : 1));
  }
  if (best !== null) return best;
  return looseCount === 1 ? loose : null;
}

/** Where `anchor` goes when `oldText` is replaced by `newText`. */
export function reanchorResearchQuote(anchor: AnchorQuote, oldText: string, newText: string): ResearchAnchorOutcome {
  const quote = normalize(anchor.exact);
  if (!quote) return { kind: "unchanged" };
  const prefix = lastCodePoints(normalize(anchor.prefix), RESEARCH_ANCHOR_CONTEXT_CHARS);
  const suffix = firstCodePoints(normalize(anchor.suffix), RESEARCH_ANCHOR_CONTEXT_CHARS);
  const oldOffset = locate(normalizeWithOffsets(oldText), quote, prefix, suffix, anchor.start);
  if (oldOffset === null) return { kind: "unchanged" };
  const newOffset = locate(normalizeWithOffsets(newText), quote, prefix, suffix, oldOffset);
  if (newOffset === null) return { kind: "unmatched" };
  const start = Math.max(0, anchor.start + newOffset - oldOffset);
  return { kind: "moved", start, end: start + Math.max(0, anchor.end - anchor.start) };
}

/** How many of `anchors` no longer match after the edit. The old and new
 * texts are normalized once for all anchors. */
export function countUnmatchedResearchAnchors(
  anchors: readonly AnchorQuote[],
  oldText: string,
  newText: string,
): number {
  if (anchors.length === 0 || oldText === newText) return 0;
  const oldNormalized = normalizeWithOffsets(oldText);
  const newNormalized = normalizeWithOffsets(newText);
  let unmatched = 0;
  for (const anchor of anchors) {
    const quote = normalize(anchor.exact);
    if (!quote) continue;
    const prefix = lastCodePoints(normalize(anchor.prefix), RESEARCH_ANCHOR_CONTEXT_CHARS);
    const suffix = firstCodePoints(normalize(anchor.suffix), RESEARCH_ANCHOR_CONTEXT_CHARS);
    const oldOffset = locate(oldNormalized, quote, prefix, suffix, anchor.start);
    if (oldOffset === null) continue;
    if (locate(newNormalized, quote, prefix, suffix, oldOffset) === null) unmatched += 1;
  }
  return unmatched;
}
