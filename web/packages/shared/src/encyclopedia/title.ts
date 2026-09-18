// Turning a generated page into its stored form: unwrapping the model's raw
// output, splitting the leading heading off as the title, and the caps the
// page prompt is assembled under.
//
// Ported from the desktop backend `src-tauri/src/encyclopedia.rs`
// (`normalize_page`, `split_title`, and the cap constants at the top of the
// module). The desktop had two transports — an OpenRouter call and the
// answering agent's CLI — and both needed the same tolerance for what a model
// actually returns; the web has one generation path
// (`04-agent-runtime.md` §9) and keeps the tolerance for the same reason.

import { stripWikilinks } from "../markdown/wikilinks.js";

/** Caps applied when a page request is stored and when its prompt is built.
 * Sources beyond `MAX_ENCYCLOPEDIA_SOURCES_IN_PROMPT` still count as
 * backlinks; they stay out of the prompt so it cannot grow without bound. */
export const MAX_ENCYCLOPEDIA_TITLE_CHARS = 160;
export const MAX_ENCYCLOPEDIA_QUESTION_CHARS = 600;
export const MAX_ENCYCLOPEDIA_EXCERPT_CHARS = 4_000;
export const MAX_ENCYCLOPEDIA_SIBLING_TERMS = 24;
export const MAX_ENCYCLOPEDIA_SOURCES_IN_PROMPT = 5;
export const MAX_ENCYCLOPEDIA_EXISTING_PAGES_IN_PROMPT = 120;

/** The Unicode White_Space property, as `truncate_chars`'s `split_whitespace`
 * read it. JavaScript's `\s` is the same set plus U+FEFF and minus U+0085, so
 * the property escape is used instead — as in `research/preview.ts`. */
const WHITESPACE_RUN = /\p{White_Space}+/u;

/** Collapse whitespace and cut to `limit` code points, marking the cut with
 * an ellipsis. */
export function truncateEncyclopediaText(value: string, limit: number): string {
  const collapsed = value.split(WHITESPACE_RUN).filter(Boolean).join(" ");
  const characters = [...collapsed];
  return characters.length <= limit ? collapsed : `${characters.slice(0, limit).join("")}…`;
}

/** How many JSON wrappers to peel off a generated page. */
const MAX_PAGE_JSON_LAYERS = 3;

function unwrapPageJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const page = (parsed as Record<string, unknown>).page;
  return typeof page === "string" ? page.trim() : null;
}

/** The Markdown page out of the generator's raw value. Models sometimes
 * JSON-encode the whole `{"page": …}` object into the string; peel that off (a
 * few levels, in case it happened more than once) so raw JSON never becomes a
 * page body. An object without a `page` string is left as text for the reader
 * to see. Returns null when nothing is left. */
export function normalizePage(raw: string): string | null {
  let text = raw.trim();
  for (let layer = 0; layer < MAX_PAGE_JSON_LAYERS; layer += 1) {
    if (!text.startsWith("{")) break;
    const inner = unwrapPageJson(text);
    if (inner === null) break;
    text = inner;
  }
  return text ? text : null;
}

/** Stray characters a model occasionally emits before the heading (seen live:
 * `ic# ORCID`). A heading this close to the start is still the heading. */
const MAX_HEADING_PREFIX_CHARS = 12;

export interface EncyclopediaTitleSplit {
  title: string;
  /** The Markdown body without the title heading. */
  body: string;
}

/** Splits the generated Markdown into its heading and body. A page without a
 * leading level-1 heading keeps the term as its title. */
export function splitTitle(markdown: string, term: string): EncyclopediaTitleSplit {
  let trimmed = markdown.trim();
  if (!trimmed.startsWith("# ")) {
    const offset = trimmed.indexOf("# ");
    if (
      offset > 0 &&
      offset <= MAX_HEADING_PREFIX_CHARS &&
      !trimmed.slice(0, offset).includes("\n")
    ) {
      trimmed = trimmed.slice(offset);
    }
  }
  if (trimmed.startsWith("# ")) {
    const rest = trimmed.slice("# ".length);
    const breakAt = rest.indexOf("\n");
    const heading = breakAt >= 0 ? rest.slice(0, breakAt) : rest;
    const body = breakAt >= 0 ? rest.slice(breakAt + 1) : "";
    const stripped = stripWikilinks(heading.trim().replace(/#+$/, "").trim());
    const title = truncateEncyclopediaText(stripped, MAX_ENCYCLOPEDIA_TITLE_CHARS);
    if (title) {
      return { title, body: body.trim() };
    }
  }
  return { title: term, body: trimmed };
}
