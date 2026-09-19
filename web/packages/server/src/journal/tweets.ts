// The tweet pipeline (`03-api-and-events.md` §2, `journal.rs:142-187`).
//
// Every hydration on the web goes through here: a journal entry someone saved,
// and the posts a research question links to (`attachments.ts`). The fetch is
// the server's because the browser cannot make it — the syndication CDN's CORS
// admits `platform.twitter.com` and nothing else — and because one cache in
// front of it serves every reader of a public card.
//
// Two providers, in order. `cdn.syndication.twimg.com` first: it returns the
// whole post, which is what the card renders (media, quoted post, link card,
// counts). `publish.twitter.com/oembed` second (`oembed.ts`), which keeps
// answering for posts syndication has stopped serving but returns only author,
// text and date. Which one answered is stored, so a reduced card is
// recognizable as one rather than looking like a post that lost its media.

import { tweets } from "@session/db";
import type { SessionDatabase } from "@session/db";
import type {
  TweetAttachmentFailure,
  TweetAttachmentProvider,
  TweetSnapshot,
} from "@session/shared";
import {
  classifyTweetFetchFailure,
  syndicationToken,
  tweetSnapshotFromSyndication,
} from "@session/shared";

import { cacheSnapshotImages } from "../embeds/storage.js";
import type { Logger } from "../logger.js";

import { fetchTweetOembed, tweetSnapshotFromOembed } from "./oembed.js";

const SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";

/** The desktop's cap, kept: `tweet_cache.payload_json` is bounded at 1 MiB. */
export const MAX_TWEET_RESPONSE_BYTES = 1024 * 1024;

/** Syndication CDN fetch timeout in milliseconds. */
export const TWEET_FETCH_TIMEOUT_MS = 10_000;

/** A cached payload this new is reused rather than refetched. */
export const TWEET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class TweetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TweetFetchError";
  }
}

/** A status id, as every permalink parser produces one. */
const TWEET_ID = /^[0-9]{1,25}$/;

export function validateTweetFetchArgs(id: string, token: string): void {
  if (!TWEET_ID.test(id)) {
    throw new TweetFetchError(
      "Invalid tweet ID: expected a numeric string of at most 25 characters.",
    );
  }
  if (token === "" || token.length > 32 || !/^[a-zA-Z0-9]+$/.test(token)) {
    throw new TweetFetchError(
      "Invalid tweet token: expected an alphanumeric string of at most 32 characters.",
    );
  }
}

export function syndicationUrl(id: string, token: string): string {
  const url = new URL(SYNDICATION_ENDPOINT);
  url.searchParams.set("id", id);
  url.searchParams.set("token", token);
  url.searchParams.set("lang", "en");
  return url.toString();
}

/** Fetches the raw syndication body, refusing anything over the cap before it
 * is buffered when the response declares a length, and while reading when it
 * does not. */
export async function fetchTweetJson(
  doFetch: typeof globalThis.fetch,
  id: string,
  token: string,
): Promise<string> {
  validateTweetFetchArgs(id, token);
  const response = await doFetch(syndicationUrl(id, token), {
    headers: { "User-Agent": "session", Accept: "application/json" },
    // Enforces timeout on CDN responses to prevent stalled connections.
    signal: AbortSignal.timeout(TWEET_FETCH_TIMEOUT_MS),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_TWEET_RESPONSE_BYTES) {
    throw new TweetFetchError("Tweet response exceeds maximum allowed size");
  }
  if (!response.ok) {
    throw new TweetFetchError(`Tweet fetch request failed with HTTP ${response.status}.`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_TWEET_RESPONSE_BYTES) {
    throw new TweetFetchError("Tweet response exceeds maximum allowed size");
  }
  return body;
}

/** What a hydration ended with. `failure` is the sentence a card shows and the
 * one `tweet_cache` stores; `failureKind` is the same outcome in the taxonomy
 * an attachment records. */
export interface TweetResolution {
  status: "resolved" | "unavailable";
  snapshot: TweetSnapshot | null;
  /** Which provider produced `snapshot`; null when none did. */
  provider: TweetAttachmentProvider | null;
  /** The raw body the snapshot was normalized from, for the proxy's callers. */
  payload: unknown;
  /** True when the answer came from `tweet_cache` rather than a fetch. */
  cached: boolean;
  failure: string | null;
  failureKind: TweetAttachmentFailure | null;
  fetchedAt: number;
}

/** What a post that resolved to nothing says on the card. */
export const TWEET_UNAVAILABLE_MESSAGE = "This post is unavailable.";

export interface TweetHydrationDeps {
  db: SessionDatabase;
  fetch: typeof globalThis.fetch;
  logger?: Logger | undefined;
}

function unavailable(message: string, cached: boolean, fetchedAt: number): TweetResolution {
  return {
    status: "unavailable",
    snapshot: null,
    provider: null,
    payload: null,
    cached,
    failure: message,
    failureKind: classifyTweetFetchFailure(message),
    fetchedAt,
  };
}

/** One syndication attempt, reduced to a snapshot or the reason there is
 * none. Never throws: the caller has a second provider to try. */
async function fromSyndication(
  deps: TweetHydrationDeps,
  id: string,
): Promise<{ snapshot: TweetSnapshot | null; payload: unknown; failure: string | null }> {
  let body: string;
  try {
    body = await fetchTweetJson(deps.fetch, id, syndicationToken(id));
  } catch (error) {
    return {
      snapshot: null,
      payload: null,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { snapshot: null, payload: null, failure: "the tweet response was not valid JSON" };
  }
  const snapshot = tweetSnapshotFromSyndication(id, payload);
  // A tombstone parses: deleted, withheld and protected posts come back as
  // `TweetTombstone`, which is an answer, not a transport failure.
  return { snapshot, payload, failure: snapshot ? null : TWEET_UNAVAILABLE_MESSAGE };
}

/** One oEmbed attempt. Never throws, for the same reason. */
async function fromOembed(
  deps: TweetHydrationDeps,
  id: string,
  handle: string | undefined,
): Promise<{ snapshot: TweetSnapshot | null; payload: unknown }> {
  try {
    const payload = await fetchTweetOembed(deps.fetch, id, handle);
    return { snapshot: await tweetSnapshotFromOembed(id, payload), payload };
  } catch (error) {
    deps.logger?.debug({ tweetId: id, error }, "the oEmbed fallback did not resolve a post");
    return { snapshot: null, payload: null };
  }
}

/**
 * Writes the attempt to `tweet_cache`, or logs why it could not be. The cache
 * is an optimization: a post that resolved must still render when the row
 * cannot be written (an oversized payload, a database error), which is why
 * nothing here is allowed to escape into a hydration that already succeeded.
 */
function remember(
  deps: TweetHydrationDeps,
  input: Parameters<typeof tweets.put>[1],
): number | null {
  try {
    return tweets.put(deps.db, input).fetchedAt;
  } catch (error) {
    deps.logger?.warn({ tweetId: input.tweetId, error }, "could not cache a post");
    return null;
  }
}

/** Registers the snapshot's images for `/embeds/<hash>`, or leaves them
 * pointing at their origin. Same reasoning as {@link remember}: a card whose
 * images are not cached is better than no card. */
function withCachedImages(deps: TweetHydrationDeps, snapshot: TweetSnapshot): TweetSnapshot {
  try {
    return cacheSnapshotImages(deps.db, snapshot);
  } catch (error) {
    deps.logger?.warn({ tweetId: snapshot.id, error }, "could not register a post's images");
    return snapshot;
  }
}

/**
 * The cache-first hydration path: a fresh row is returned as it is, and every
 * attempt — resolved or not — is written back, so a deleted post is not
 * refetched on every render. It answers rather than throws, so a caller can
 * record the outcome on the entry or the attachment it belongs to.
 *
 * A snapshot is stored with its images rewritten to `/embeds/<hash>`
 * (`embeds/storage.ts`), which is also what registers them for fetching; the
 * rewrite happens once here rather than on every render.
 */
export async function resolveTweet(
  deps: TweetHydrationDeps,
  id: string,
  options: { now?: number; handle?: string | undefined } = {},
): Promise<TweetResolution> {
  const now = options.now ?? Date.now();
  // Every caller derives the id with `tweetIdFromUrl`, but `journal.restore`
  // hands back a whole entry the client was holding, `tweet_id` included. The
  // shape is checked once here so a malformed id is answered without asking
  // either provider about it.
  if (!TWEET_ID.test(id)) {
    return unavailable("Invalid tweet ID.", false, now);
  }
  const cached = tweets.get(deps.db, id);
  if (cached && now - cached.fetchedAt < TWEET_CACHE_TTL_MS) {
    if (cached.status === "resolved" && cached.snapshot) {
      return {
        status: "resolved",
        snapshot: cached.snapshot,
        provider: cached.provider ?? "xSyndication",
        payload: cached.payload,
        cached: true,
        failure: null,
        failureKind: null,
        fetchedAt: cached.fetchedAt,
      };
    }
    return unavailable(cached.failure ?? TWEET_UNAVAILABLE_MESSAGE, true, cached.fetchedAt);
  }

  const syndication = await fromSyndication(deps, id);
  let snapshot = syndication.snapshot;
  let payload = syndication.payload;
  let provider: TweetAttachmentProvider = "xSyndication";
  // The fallback is for a post syndication will not serve — a 404, a rate
  // limit, a tombstone — not for one it did not answer about at all. A
  // timeout means the path to X is slow or blocked, where a second request
  // only makes the caller wait twice for the same silence; the attempt is
  // recorded `timeout`, which is the one failure worth retrying.
  if (!snapshot && classifyTweetFetchFailure(syndication.failure ?? "") !== "timeout") {
    const fallback = await fromOembed(deps, id, options.handle);
    if (fallback.snapshot) {
      snapshot = fallback.snapshot;
      payload = fallback.payload;
      provider = "xOembed";
    }
  }

  if (!snapshot) {
    // The syndication failure is what is reported: it is the provider that was
    // asked about the post itself, and "HTTP 404" from it says more than the
    // publish endpoint declining to render a card.
    const message = syndication.failure ?? TWEET_UNAVAILABLE_MESSAGE;
    remember(deps, { tweetId: id, status: "unavailable", failure: message });
    return unavailable(message, false, now);
  }

  const stored = withCachedImages(deps, snapshot);
  const fetchedAt = remember(deps, {
    tweetId: id,
    payload,
    snapshot: stored,
    status: "resolved",
    provider,
  });
  return {
    status: "resolved",
    snapshot: stored,
    provider,
    payload,
    cached: false,
    failure: null,
    failureKind: null,
    fetchedAt: fetchedAt ?? now,
  };
}
