// oEmbed fallback for tweet hydration (`03-api-and-events.md` §2).
//
// The syndication CDN provides complete snapshots (media, quoted posts, cards,
// and interaction counts), but returns 404 once its widget tier stops serving a
// post and applies rate limits during high request volume. The secondary
// endpoint `publish.twitter.com/oembed` remains available in those cases.
// It returns rendered HTML containing author name, handle, date, and text.
// Posts resolved through oEmbed contain only text, author, and timestamp,
// recording `xOembed` as the provider to indicate reduced metadata.
//
// The received HTML is parsed into plain text and link runs rather than
// executed as DOM markup, and href attributes are sanitized with `tweetWebUrl`.

import type { TweetSnapshot, TweetTextRun } from "@session/shared";
import { storableTweetSnapshot, tweetWebUrl } from "@session/shared";

import { ResponseTooLargeError, readCappedText } from "../net/readCapped.js";

const OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";

/** Upper bound on response size to prevent unbounded buffering of invalid responses. */
export const MAX_OEMBED_RESPONSE_BYTES = 256 * 1024;

export const OEMBED_FETCH_TIMEOUT_MS = 8_000;

/** X handles are `[A-Za-z0-9_]` and at most 15 characters. A source URL's
 * handle is validated before inclusion in constructed permalinks. */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Constructs the status permalink for the oEmbed endpoint from the numeric ID.
 * Uses `handle` if valid, otherwise falls back to `i`.
 */
export function oembedTweetUrl(id: string, handle?: string): string {
  const segment = handle !== undefined && HANDLE.test(handle) ? handle : "i";
  return `https://twitter.com/${segment}/status/${id}`;
}

export function oembedRequestUrl(id: string, handle?: string): string {
  const url = new URL(OEMBED_ENDPOINT);
  url.searchParams.set("url", oembedTweetUrl(id, handle));
  // Omit widget scripts, tracking, and styling to request a minimal blockquote.
  url.searchParams.set("omit_script", "1");
  url.searchParams.set("dnt", "1");
  url.searchParams.set("lang", "en");
  return url.toString();
}

export interface OembedPayload {
  html?: unknown;
  author_name?: unknown;
  author_url?: unknown;
  url?: unknown;
}

/** Fetches the oEmbed payload, enforcing maximum byte limits and timeout. */
export async function fetchTweetOembed(
  doFetch: typeof globalThis.fetch,
  id: string,
  handle?: string,
): Promise<OembedPayload> {
  const response = await doFetch(oembedRequestUrl(id, handle), {
    headers: { "User-Agent": "session", Accept: "application/json" },
    signal: AbortSignal.timeout(OEMBED_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`the oEmbed request failed with HTTP ${response.status}`);
  }
  let body: string;
  try {
    body = await readCappedText(response, MAX_OEMBED_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new Error("the oEmbed response exceeds the maximum allowed size");
    }
    throw error;
  }
  try {
    return JSON.parse(body) as OembedPayload;
  } catch {
    throw new Error("the oEmbed response was not valid JSON");
  }
}

/**
 * Minimal DOM interface types for `linkedom`.
 *
 * Uses numeric node types rather than `instanceof` checks because the server
 * runtime environment does not include browser DOM type definitions.
 */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface OembedNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<OembedNode>;
  getAttribute?: (name: string) => string | null;
}

interface OembedDocument {
  querySelector(selector: string): OembedNode | null;
  querySelectorAll(selector: string): ArrayLike<OembedNode>;
}

type ParseHtml = (html: string) => { document: OembedDocument };

function children(node: OembedNode): OembedNode[] {
  return Array.from(
    { length: node.childNodes.length },
    (_, index) => node.childNodes[index],
  ).filter((child): child is OembedNode => child !== undefined);
}

/**
 * Converts blockquote paragraph contents into display runs. Text nodes become
 * plain text runs; anchors become link runs with sanitized targets; `<br>`
 * elements become newline text runs. Unlike syndication payloads, oEmbed HTML
 * does not provide expanded URL entities, so link runs preserve the shortlink target.
 */
export function oembedTextRuns(paragraph: OembedNode): TweetTextRun[] {
  const runs: TweetTextRun[] = [];
  const pushText = (text: string): void => {
    if (text === "") {
      return;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === "text") {
      last.text += text;
      return;
    }
    runs.push({ kind: "text", text });
  };
  for (const child of children(paragraph)) {
    if (child.nodeType === TEXT_NODE) {
      pushText(child.textContent ?? "");
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) {
      continue;
    }
    const name = child.nodeName.toLowerCase();
    if (name === "br") {
      pushText("\n");
      continue;
    }
    const text = (child.textContent ?? "").trim();
    const href = name === "a" ? tweetWebUrl(child.getAttribute?.("href") ?? undefined) : undefined;
    if (href !== undefined && text !== "") {
      runs.push({ kind: "link", text, url: href });
      continue;
    }
    pushText(child.textContent ?? "");
  }
  // Trims leading and trailing whitespace introduced by blockquote markup formatting.
  const first = runs[0];
  if (first?.kind === "text") {
    first.text = first.text.replace(/^\s+/, "");
  }
  const last = runs[runs.length - 1];
  if (last?.kind === "text") {
    last.text = last.text.replace(/\s+$/, "");
  }
  return runs.filter((run) => run.kind !== "text" || run.text !== "");
}

/** Extracts the author handle from `author_url` (e.g. `https://twitter.com/jack`). */
export function oembedHandle(authorUrl: unknown): string | undefined {
  if (typeof authorUrl !== "string") {
    return undefined;
  }
  const url = URL.parse(authorUrl);
  const segment = url?.pathname.split("/").filter(Boolean)[0];
  return segment !== undefined && HANDLE.test(segment) ? segment : undefined;
}

/**
 * Parses the blockquote sign-off date (e.g. "March 21, 2006") as an ISO
 * timestamp. Evaluated as UTC midnight because the endpoint returns only
 * date resolution without time or timezone.
 */
export function oembedCreatedAt(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Date.parse(`${trimmed} UTC`);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * Normalizes an oEmbed payload into a `TweetSnapshot`, or null if invalid.
 * Uses the requested ID and reconstructs the canonical permalink with the
 * returned author handle.
 */
export async function tweetSnapshotFromOembed(
  id: string,
  payload: OembedPayload,
): Promise<TweetSnapshot | null> {
  const html = typeof payload.html === "string" ? payload.html : null;
  const handle = oembedHandle(payload.author_url);
  if (html === null || handle === undefined) {
    return null;
  }
  const { parseHTML } = (await import("linkedom")) as unknown as { parseHTML: ParseHtml };
  const { document } = parseHTML(html);
  const paragraph = document.querySelector("blockquote p");
  const anchors = document.querySelectorAll("blockquote > a");
  const signOff = anchors[anchors.length - 1];
  const name = typeof payload.author_name === "string" ? payload.author_name.trim() : "";
  const createdAt = oembedCreatedAt(signOff?.textContent);
  const snapshot: TweetSnapshot = {
    id,
    url: `https://x.com/${handle}/status/${id}`,
    author: { name: name === "" ? handle : name, handle },
    ...(createdAt === undefined ? {} : { createdAt }),
    runs: paragraph ? oembedTextRuns(paragraph) : [],
    // The endpoint returns complete text, but excludes media, quoted posts,
    // link cards, and counts; recorded as `xOembed` to denote limited metadata.
    partial: false,
    media: [],
  };
  return storableTweetSnapshot(snapshot);
}
