// Bounded, single-line projections of research text: the card preview, the
// fallback title for a prompt, and the sanitizer applied to generated titles.
//
// Ported from `response_preview`, `default_title`, `normalized_prefix` and
// `normalized_text` in `src-tauri/src/research.rs`, and
// `sanitize_research_title` in `src-tauri/src/title_generation.rs`. Every
// limit here counts Unicode scalar values (Rust `chars()`), not UTF-8 bytes
// and not UTF-16 code units, so the TypeScript iterates code points: a string
// index would cut an astral character in half and would also count it twice
// against the limit.
//
// The desktop resolved a response boundary first, because a node's turns were
// a slice of a long-lived terminal session's transcript. On the web a run owns
// its turns, so the whole list is the response (`04-agent-runtime.md` §5) and
// the boundary argument is gone.

import { stripWikilinks } from "../markdown/wikilinks.js";
import type { Turn } from "../types/turn.js";

/** Longest response preview stored on a node, in code points. */
const PREVIEW_MAX_CHARS = 220;

/** Longest title derived from a prompt, in code points. */
const DEFAULT_TITLE_MAX_CHARS = 72;

/** Longest generated title, in code points (`title_generation.rs`). */
export const RESEARCH_TITLE_MAX_CHARS = 80;

/** Whitespace as Rust's `char::is_whitespace` sees it — the Unicode
 * White_Space property. JavaScript's `\s` is the same set plus U+FEFF and
 * minus U+0085, so the property escape is used instead. */
const WHITESPACE_RUN = /\p{White_Space}+/u;

const TRAILING_WHITESPACE = /\p{White_Space}+$/u;

/** Collapses every whitespace run to a single space and trims the ends. */
export function normalizedText(value: string): string {
  return value
    .split(WHITESPACE_RUN)
    .filter((word) => word.length > 0)
    .join(" ");
}

export interface NormalizedPrefix {
  value: string;
  truncated: boolean;
}

/**
 * Normalizes whitespace while retaining at most `maxChars` Unicode scalar
 * values. Unlike collecting and joining every word, this stops as soon as the
 * bounded UI string is known, which matters for 10 MB document lines.
 */
export function normalizedPrefix(text: string, maxChars: number): NormalizedPrefix {
  let value = "";
  let charCount = 0;
  for (const word of text.split(WHITESPACE_RUN)) {
    if (word.length === 0) {
      continue;
    }
    if (charCount > 0) {
      if (charCount === maxChars) {
        return { value, truncated: true };
      }
      value += " ";
      charCount += 1;
    }
    for (const character of word) {
      if (charCount === maxChars) {
        return { value, truncated: true };
      }
      value += character;
      charCount += 1;
    }
  }
  return { value, truncated: false };
}

/** A turn the model still has in context: not superseded by a retry, not
 * rolled back. Mirrors `turn_is_in_active_context` in `research.rs`. */
export function turnIsInActiveContext(turn: Turn): boolean {
  return turn.status !== "superseded" && turn.contextStatus !== "rolledBack";
}

function ellipsized(prefix: NormalizedPrefix): string {
  return prefix.truncated ? `${prefix.value.replace(TRAILING_WHITESPACE, "")}…` : prefix.value;
}

/**
 * The card preview for a node's answer: the assistant prose written after the
 * last tool activity, or the first assistant prose in the response when a
 * trailing tool call cleared that (the same fold the viewer shows).
 */
export function responsePreview(turns: readonly Turn[]): string | undefined {
  let fallbackText: string | undefined;
  let textAfterLastActivity: string | undefined;
  for (const turn of turns) {
    if (!turnIsInActiveContext(turn)) {
      continue;
    }
    for (const block of turn.blocks) {
      if (block.type === "text") {
        if (turn.role !== "user" && block.text.trim() !== "") {
          fallbackText ??= block.text;
          textAfterLastActivity ??= block.text;
        }
      } else if (block.type === "toolUse" || block.type === "toolResult") {
        textAfterLastActivity = undefined;
      } else if (turn.role === "assistant") {
        // A raw block on an assistant turn is reasoning or provider
        // bookkeeping: prose before it is not the answer's tail.
        textAfterLastActivity = undefined;
      }
    }
  }
  const text = textAfterLastActivity ?? fallbackText;
  if (text === undefined) {
    return undefined;
  }
  // Strip before cutting so a `[[Term]]` marker never straddles the cut.
  return ellipsized(normalizedPrefix(stripWikilinks(text), PREVIEW_MAX_CHARS));
}

/** Title for a node with no generated one: the prompt, normalized and cut. */
export function defaultTitle(prompt: string): string {
  const prefix = normalizedPrefix(prompt, DEFAULT_TITLE_MAX_CHARS);
  if (prefix.truncated) {
    return ellipsized(prefix);
  }
  return prefix.value === "" ? "Untitled research" : prefix.value;
}

/** The label the metadata model sometimes prefixes, in the two casings the
 * desktop stripped. A model that shouts `TITLE:` keeps it, as before. */
const TITLE_LABELS = ["Title:", "title:"];
const TITLE_QUOTES = /^["'`]+|["'`]+$/g;
const TRAILING_PERIODS = /\.+$/;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * Cleans a model-generated title: control characters become spaces, a
 * `Title:` label and surrounding quotes are dropped, trailing periods go, and
 * the result is cut to {@link RESEARCH_TITLE_MAX_CHARS} code points with an
 * ellipsis. Returns `undefined` when nothing is left, which means the caller
 * keeps the title it already had.
 */
export function sanitizeResearchTitle(raw: string): string | undefined {
  const normalized = normalizedText(raw.replace(CONTROL_CHARACTERS, " "));
  const label = TITLE_LABELS.find((candidate) => normalized.startsWith(candidate));
  const withoutLabel = (label === undefined ? normalized : normalized.slice(label.length)).trim();
  const unquoted = withoutLabel.replace(TITLE_QUOTES, "").replace(TRAILING_PERIODS, "").trim();
  if (unquoted === "") {
    return undefined;
  }
  const characters = [...unquoted];
  if (characters.length <= RESEARCH_TITLE_MAX_CHARS) {
    return unquoted;
  }
  const head = characters.slice(0, RESEARCH_TITLE_MAX_CHARS - 1).join("");
  return `${head.replace(TRAILING_WHITESPACE, "")}…`;
}
