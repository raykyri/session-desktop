// Answer recaps: the one-or-two-sentence summary shown under a settled
// research answer, and the rules that decide when one is worth generating.
//
// Ported from `src-tauri/src/research_recap.rs`. The scheduling predicate and
// the dedupe key are the pure parts of `schedule` (`research_recap.rs:30-100`);
// the thread spawn, the job set, and the `research.recap.pending` emit belong
// to the server's metadata runner (`04-agent-runtime.md` §9), which calls these
// to decide whether to run at all. The desktop also required the node's
// adapter to be one of the three CLIs that could summarize; every web model
// can, so that clause is gone.
//
// Recaps are derived metadata: generation never delays research completion,
// and every rejection here is silent — the answer simply has no summary.

import { stripWikilinks } from "../markdown/wikilinks.js";
import type { ResearchNode } from "../types/research.js";
import type { Turn } from "../types/turn.js";

import { normalizedText, turnIsInActiveContext } from "./preview.js";

/** Shortest answer worth summarizing, in code points of plain text. Below it
 * the answer is already about as short as its recap would be. */
export const MIN_RECAP_CHARS = 800;

/** Longest generated recap accepted, in code points. */
export const MAX_RECAP_CHARS = 1_200;

/** Longest user-supplied recap instructions, in code points. */
export const MAX_RECAP_INSTRUCTIONS_CHARS = 4_000;

/** Bound on automatic summary input for generated runs, in UTF-8 bytes.
 * Imported reports bypass this cutoff so their complete text reaches the
 * summarizer. `MAX_SOURCE_BYTES` in `research_recap.rs`. */
export const MAX_RECAP_SOURCE_BYTES = 80_000;

export const DEFAULT_RECAP_INSTRUCTIONS =
  "Write a concise recap that directly answers the user's question using only the supplied answer. Aim for 30–70 words. For recommendations, name the recommended items and people. For analysis, preserve the main conclusion, mechanism, and essential qualifications. Focus on the findings rather than describing the answer's topics.";

const UTF8 = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8.encode(value).length;
}

/** Code points, as Rust's `chars().count()`. */
function codePointCount(value: string): number {
  return [...value].length;
}

// Plain text from Markdown.
//
// The desktop ran the source through pulldown-cmark and kept the text of
// `Text` and `Code` events, turning breaks and block ends into spaces. `shared`
// takes no dependencies, so the same projection is done with line and inline
// rules: the result feeds a summarizer and two length gates, both of which
// only need the visible words. What must hold — and what `researchRecap.test.ts`
// pins — is that markup characters, link targets, and wikilink brackets never
// count toward the gates, and that code-block and code-span contents do.

const FENCE = /^\p{White_Space}*(?:```+|~~~+)/u;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\p{White_Space}+|$)/u;
const TRAILING_HEADING_MARKERS = /\p{White_Space}+#+\p{White_Space}*$/u;
const BLOCK_QUOTE = /^ {0,3}(?:>\p{White_Space}?)+/u;
const LIST_MARKER = /^\p{White_Space}*(?:[-*+]|\d{1,9}[.)])(?:\p{White_Space}+|$)/u;
/** A thematic break, a setext underline, or a table delimiter row: rules and
 * table structure carry no text of their own. */
const STRUCTURAL_LINE = /^\p{White_Space}*(?:[-*_=|:]\p{White_Space}*){3,}$/u;
/** `[text](target)` and `![alt](target)`, plus their reference forms. */
const LINK = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const REFERENCE_LINK = /!?\[([^\]]*)\]\[[^\]]*\]/g;
const AUTOLINK = /<((?:[a-z][a-z0-9+.-]*:|www\.)[^\s<>]*)>/gi;
const HTML_TAG = /<\/?[A-Za-z][^<>]*>|<!--[\s\S]*?-->/g;
const CODE_SPAN_DELIMITER = /`+/g;
/** An emphasis, strong, or strikethrough run: a delimiter only when it sits
 * against text on the inside, so `snake_case` and `2 * 3` keep their
 * characters. */
const OPENING_DELIMITER = /(^|[^\p{L}\p{N}])([*_~]{1,3})(?=[^\s*_~])/gu;
const CLOSING_DELIMITER = /(?<=[^\s*_~])([*_~]{1,3})(?=[^\p{L}\p{N}]|$)/gu;
const BACKSLASH_ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;

function inlinePlainText(line: string): string {
  return line
    .replace(LINK, "$1")
    .replace(REFERENCE_LINK, "$1")
    .replace(AUTOLINK, "$1")
    .replace(HTML_TAG, "")
    .replace(CODE_SPAN_DELIMITER, "")
    .replace(OPENING_DELIMITER, "$1")
    .replace(CLOSING_DELIMITER, "")
    .replace(BACKSLASH_ESCAPE, "$1");
}

function plainText(markdown: string): string {
  // `[[Term]]` markers are renderer machinery; the summarizer sees words.
  const lines = stripWikilinks(markdown).split("\n");
  const parts: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      parts.push(line);
      continue;
    }
    if (STRUCTURAL_LINE.test(line)) {
      continue;
    }
    const block = line
      .replace(BLOCK_QUOTE, "")
      .replace(LIST_MARKER, "")
      .replace(ATX_HEADING, "")
      .replace(TRAILING_HEADING_MARKERS, "")
      .replace(/\|/g, " ");
    parts.push(inlinePlainText(block));
  }
  return normalizedText(parts.join(" "));
}

/**
 * The text a recap is generated from: assistant prose after the last tool
 * activity, keeping the most recent text group as a fallback for a trailing
 * housekeeping tool call, like the UI's fold. User turns, tool payloads, and
 * raw reasoning blocks never enter the summarizer.
 *
 * Returns `undefined` when the answer is not worth summarizing. An imported
 * report only has to be non-empty; a generated answer must be at least
 * {@link MIN_RECAP_CHARS} code points and no more than
 * {@link MAX_RECAP_SOURCE_BYTES}.
 */
export function extractRecapSource(turns: readonly Turn[], imported: boolean): string | undefined {
  let text: string[] = [];
  let fallback: string[] = [];
  for (const turn of turns) {
    if (!turnIsInActiveContext(turn)) {
      continue;
    }
    for (const block of turn.blocks) {
      if (block.type === "text") {
        if (turn.role === "assistant" && block.text.trim() !== "") {
          text.push(block.text);
        }
      } else if (block.type === "toolUse" || block.type === "toolResult") {
        if (text.length > 0) {
          fallback = text;
          text = [];
        }
      }
    }
  }
  const plain = plainText((text.length > 0 ? text : fallback).join("\n\n"));
  if (imported) {
    return plain === "" ? undefined : plain;
  }
  const withinBounds =
    codePointCount(plain) >= MIN_RECAP_CHARS && utf8ByteLength(plain) <= MAX_RECAP_SOURCE_BYTES;
  return withinBounds ? plain : undefined;
}

/** {@link extractRecapSource} for a node, which knows whether it was imported. */
export function recapSourceForNode(
  node: Pick<ResearchNode, "origin">,
  turns: readonly Turn[],
): string | undefined {
  return extractRecapSource(turns, node.origin === "imported");
}

/**
 * Whether the source and the prompt together fit the summarizer's input
 * budget. Checked after extraction because the prompt is charged against the
 * same budget; imported reports are exempt, as in {@link extractRecapSource}.
 */
export function recapSourceFitsBudget(
  node: Pick<ResearchNode, "origin" | "prompt">,
  source: string,
): boolean {
  if (node.origin === "imported") {
    return true;
  }
  return utf8ByteLength(source) + utf8ByteLength(node.prompt) <= MAX_RECAP_SOURCE_BYTES;
}

const SUMMARY_LABELS = ["Summary:", "summary:"];

/**
 * Cleans a generated recap: Markdown flattened to plain text, a `Summary:`
 * label dropped, whitespace collapsed. Returns `undefined` for an empty result
 * and for runaway output over {@link MAX_RECAP_CHARS}, which is rejected
 * rather than cut mid-caveat.
 */
export function normalizeRecap(raw: string): string | undefined {
  const plain = plainText(raw);
  const label = SUMMARY_LABELS.find((candidate) => plain.startsWith(candidate));
  const text = (label === undefined ? plain : plain.slice(label.length)).trim();
  return text !== "" && codePointCount(text) <= MAX_RECAP_CHARS ? text : undefined;
}

/**
 * Validates recap instructions as entered by the user: trimmed, non-empty,
 * bounded. Throws with the message the dialog shows.
 */
export function validateRecapInstructions(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("Summary instructions are required.");
  }
  if (codePointCount(trimmed) > MAX_RECAP_INSTRUCTIONS_CHARS) {
    throw new Error(
      `Summary instructions exceed maximum length of ${MAX_RECAP_INSTRUCTIONS_CHARS} characters.`,
    );
  }
  return trimmed;
}

type SchedulableNode = Pick<ResearchNode, "kind" | "status" | "responseSnapshotAt" | "recap">;

/**
 * Whether an automatic recap should be scheduled for a settled node. The node
 * must be a completed research run with a durable snapshot and no existing
 * recap. User-authored documents are excluded. A node whose kind is
 * absent is a run, as the wire types define it.
 */
export function shouldScheduleRecap(node: SchedulableNode): boolean {
  return (
    (node.kind ?? "run") === "run" &&
    node.status === "complete" &&
    node.responseSnapshotAt !== null &&
    node.responseSnapshotAt !== undefined &&
    node.recap === undefined
  );
}

/**
 * The dedupe key for a recap job. Two schedule attempts for the same answer
 * collapse to one run; a new snapshot on the same node is a different answer
 * and gets its own. The desktop keyed on the workspace root as well, because
 * one process served every workspace on disk; node ids are unique across the
 * web database, so the id and the snapshot time are enough.
 */
export function recapJobKey(node: Pick<ResearchNode, "id" | "responseSnapshotAt">): string {
  return `${node.id}:${node.responseSnapshotAt ?? ""}`;
}
