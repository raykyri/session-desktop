// Encyclopedia pages grown from wikilinks: the excerpt sent with a page
// request, the summary list the sidebar renders, and the narrowing of a
// server event into a page update or removal.
//
// Ported from the desktop `src/lib/encyclopedia.ts`. The DOM half of that
// module (`wikilinkClickContext`, which reads the block element around a
// clicked link) stays in the client package; everything here is pure and runs
// on both sides. `buildWikilinkExcerpt` is the part the client calls with the
// text it collected, and the part the server re-applies to what it receives.

import type {
  EncyclopediaPage,
  EncyclopediaPageStatus,
  EncyclopediaPageSummary,
} from "../types/encyclopedia.js";
import type { SessionEvent } from "../types/events.js";

/** Cap on the plain-text excerpt sent with a page request. */
export const ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT = 1_500;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The head of `text` within `limit`, ending on a word boundary. With no
 * boundary inside the limit, `hard` keeps the partial head; otherwise the
 * result is empty, since a fragment of one word adds no context. */
function cutAtWordStart(text: string, limit: number, hard = false): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return cut > 0 ? head.slice(0, cut) : hard ? head : "";
}

/** The tail of `text` within `limit`, starting on a word boundary. */
function cutAtWordEnd(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  const cut = tail.indexOf(" ");
  return cut >= 0 ? tail.slice(cut + 1) : "";
}

const EXCERPT_SEPARATOR = "\n\n";

/** Joins the clicked block with its neighbors into one excerpt within
 * `limit` characters. The block is always kept (cut at the limit if it alone
 * exceeds it); the remaining budget is split between the tail of the previous
 * block and the head of the next, so the term's own sentence never loses room
 * to its surroundings. */
export function buildWikilinkExcerpt(
  before: string | null | undefined,
  block: string,
  after: string | null | undefined,
  limit = ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT,
): string {
  const center = cutAtWordStart(collapseWhitespace(block), limit, true);
  const previous = collapseWhitespace(before ?? "");
  const next = collapseWhitespace(after ?? "");
  let budget =
    limit -
    center.length -
    (previous ? EXCERPT_SEPARATOR.length : 0) -
    (next ? EXCERPT_SEPARATOR.length : 0);
  const parts: string[] = [];
  if (previous && budget > 0) {
    const share = next ? Math.ceil(budget / 2) : budget;
    const piece = cutAtWordEnd(previous, share);
    if (piece) {
      parts.push(piece);
      budget -= piece.length;
    }
  }
  parts.push(center);
  if (next && budget > 0) {
    const piece = cutAtWordStart(next, budget);
    if (piece) parts.push(piece);
  }
  return parts.join(EXCERPT_SEPARATOR);
}

function compareTitles(left: EncyclopediaPageSummary, right: EncyclopediaPageSummary): number {
  return (
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left.slug.localeCompare(right.slug)
  );
}

export function upsertEncyclopediaSummary(
  pages: EncyclopediaPageSummary[],
  summary: EncyclopediaPageSummary,
): EncyclopediaPageSummary[] {
  const next = pages.filter((page) => page.slug !== summary.slug);
  next.push(summary);
  next.sort(compareTitles);
  return next;
}

export function removeEncyclopediaSummary(
  pages: EncyclopediaPageSummary[],
  slug: string,
): EncyclopediaPageSummary[] {
  return pages.some((page) => page.slug === slug)
    ? pages.filter((page) => page.slug !== slug)
    : pages;
}

export function encyclopediaSummaryOfPage(page: EncyclopediaPage): EncyclopediaPageSummary {
  return {
    slug: page.slug,
    term: page.term,
    title: page.title,
    status: page.status,
    workspaceId: page.workspaceId,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    sourceCount: page.sources.length,
  };
}

export function encyclopediaPageStatusBySlug(
  pages: EncyclopediaPageSummary[],
): Map<string, EncyclopediaPageStatus> {
  return new Map(pages.map((page) => [page.slug, page.status]));
}

export type EncyclopediaEvent =
  | { type: "encyclopedia.page.updated"; page: EncyclopediaPage }
  | { type: "encyclopedia.page.removed"; workspaceId: string; slug: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  // `typeof [] === "object"`, so arrays are excluded explicitly — an array
  // reaching the field checks below would be read as an object with no fields.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEncyclopediaPage(value: unknown): value is EncyclopediaPage {
  return (
    isRecord(value) &&
    typeof value.slug === "string" &&
    typeof value.term === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    (value.status === "generating" || value.status === "ready" || value.status === "failed") &&
    typeof value.model === "string" &&
    typeof value.workspaceId === "string" &&
    Array.isArray(value.sources) &&
    Array.isArray(value.links)
  );
}

/** Narrow a server event to an encyclopedia event, or null when it is
 * unrelated or malformed. */
export function parseEncyclopediaEvent(event: SessionEvent): EncyclopediaEvent | null {
  const payload = event.payload;
  if (event.type === "encyclopedia.page.updated") {
    return isEncyclopediaPage(payload.page) ? { type: event.type, page: payload.page } : null;
  }
  if (event.type === "encyclopedia.page.removed") {
    return typeof payload.workspaceId === "string" && typeof payload.slug === "string"
      ? { type: event.type, workspaceId: payload.workspaceId, slug: payload.slug }
      : null;
  }
  return null;
}
