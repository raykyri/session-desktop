// The oEmbed fallback behind tweet hydration (`03-api-and-events.md` §2).
//
// New on the web; the desktop has one pipeline. The syndication CDN is the
// source of a full snapshot — media, quoted post, link card, counts — but it
// answers 404 for a post that its widget tier has stopped serving and rate
// limits an origin that asks for many at once. `publish.twitter.com/oembed` is
// the documented endpoint, and it keeps answering in exactly those cases. What
// it returns is a rendering, not a record: one paragraph of HTML, the author's
// name and handle, and the date. So a post resolved here carries text, author
// and timestamp and nothing else, and the attachment records `xOembed` as its
// provider so a reduced card is recognizable as one.
//
// The HTML is X's own markup, but it is still third-party HTML: it is parsed
// into text and link runs rather than rendered, and every href is put through
// `tweetWebUrl` before it can reach the snapshot.

import type { TweetSnapshot, TweetTextRun } from "@session/shared";
import { storableTweetSnapshot, tweetWebUrl } from "@session/shared";

const OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";

/** The endpoint's own cap is far below this; the bound is here so a wrong
 * answer cannot be buffered without limit. */
export const MAX_OEMBED_RESPONSE_BYTES = 256 * 1024;

export const OEMBED_FETCH_TIMEOUT_MS = 8_000;

/** X handles are `[A-Za-z0-9_]` and at most 15 characters. A source URL's
 * handle is only ever echoed back into the permalink this module builds, so it
 * is checked rather than trusted. */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * The permalink the endpoint is asked about. Built here from the numeric id,
 * never taken from the caller: `handle` is used only when it is handle-shaped,
 * and `i` — X's own handle-less permalink form — otherwise.
 */
export function oembedTweetUrl(id: string, handle?: string): string {
  const segment = handle !== undefined && HANDLE.test(handle) ? handle : "i";
  return `https://twitter.com/${segment}/status/${id}`;
}

export function oembedRequestUrl(id: string, handle?: string): string {
  const url = new URL(OEMBED_ENDPOINT);
  url.searchParams.set("url", oembedTweetUrl(id, handle));
  // No widget script (nothing here renders one), no tracking, and the
  // paragraph unstyled: `omit_script` and `dnt` are what make the response a
  // small, stable blockquote.
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

/** The oEmbed body, refused over the cap and past the timeout. Throws with a
 * message the failure taxonomy can classify. */
export async function fetchTweetOembed(
  doFetch: typeof globalThis.fetch,
  id: string,
  handle?: string,
): Promise<OembedPayload> {
  const response = await doFetch(oembedRequestUrl(id, handle), {
    headers: { "User-Agent": "session", Accept: "application/json" },
    signal: AbortSignal.timeout(OEMBED_FETCH_TIMEOUT_MS),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_OEMBED_RESPONSE_BYTES) {
    throw new Error("the oEmbed response exceeds the maximum allowed size");
  }
  if (!response.ok) {
    throw new Error(`the oEmbed request failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_OEMBED_RESPONSE_BYTES) {
    throw new Error("the oEmbed response exceeds the maximum allowed size");
  }
  try {
    return JSON.parse(body) as OembedPayload;
  } catch {
    throw new Error("the oEmbed response was not valid JSON");
  }
}

/**
 * What this module reads out of `linkedom`.
 *
 * The package types itself against the DOM library, which the server does not
 * load (`lib` is ES2022, `webFetch.ts:83-101` narrows the same way). Node type
 * numbers rather than instance checks for the same reason.
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
 * The paragraph's contents as display runs. A text node is text; an anchor is
 * a link labeled the way X labeled it (a `t.co` shortlink, or the
 * `pic.twitter.com` stand-in for media this pipeline cannot render); a `<br>`
 * is the newline it stands for. Unlike the syndication path there are no URL
 * entities to expand, so a link run carries no `tco` and its target is the
 * shortlink itself.
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
  // The same edge trim the syndication normalizer applies, for the same
  // reason: the markup's own indentation is not part of the post.
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

/** The handle out of `author_url` (`https://twitter.com/jack`). */
export function oembedHandle(authorUrl: unknown): string | undefined {
  if (typeof authorUrl !== "string") {
    return undefined;
  }
  const url = URL.parse(authorUrl);
  const segment = url?.pathname.split("/").filter(Boolean)[0];
  return segment !== undefined && HANDLE.test(segment) ? segment : undefined;
}

/**
 * The date the blockquote signs off with ("March 21, 2006"), as an ISO
 * timestamp. It is a rendered date with no time and no zone, so it is read as
 * UTC midnight: the card shows a day, and a day is all the endpoint says.
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
 * Normalizes an oEmbed body into the stored snapshot, or null when it is not
 * one. The id is the one that was asked for — the endpoint answers about the
 * post at the URL this module built — and the permalink is rebuilt from the
 * handle the endpoint reported, so a snapshot can never point somewhere the
 * caller chose.
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
    // The endpoint returns the whole post, so nothing is cut off — but it
    // returns no media, no quoted post, no card and no counts, which is why
    // `provider` is stored beside the snapshot.
    partial: false,
    media: [],
  };
  return storableTweetSnapshot(snapshot);
}
