// The tweet proxy (`03-api-and-events.md` §2, `journal.rs:142-187`).
//
// The browser cannot call the syndication CDN itself: the CSP has no
// `connect-src` for it and its CORS policy only answers X's own origins. The
// server fetches instead, and — as on the desktop — builds the URL itself from
// two shape-validated parameters rather than accepting one from the caller.

import { tweets } from "@session/db";
import type { SessionDatabase } from "@session/db";
import type { TweetSnapshot } from "@session/shared";
import { tweetSnapshotFromSyndication } from "@session/shared";

const SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";

/** The desktop's cap, kept: `tweet_cache.payload_json` is bounded at 1 MiB. */
export const MAX_TWEET_RESPONSE_BYTES = 1024 * 1024;

/** How long the syndication CDN has to answer. */
export const TWEET_FETCH_TIMEOUT_MS = 10_000;

/** A cached payload this new is reused rather than refetched. */
export const TWEET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class TweetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TweetFetchError";
  }
}

export function validateTweetFetchArgs(id: string, token: string): void {
  if (id === "" || id.length > 25 || !/^[0-9]+$/.test(id)) {
    throw new TweetFetchError("invalid tweet id");
  }
  if (token === "" || token.length > 32 || !/^[a-zA-Z0-9]+$/.test(token)) {
    throw new TweetFetchError("invalid tweet token");
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
    // A syndication CDN that accepts the connection and then says nothing
    // would otherwise hold the request open for as long as it liked.
    signal: AbortSignal.timeout(TWEET_FETCH_TIMEOUT_MS),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_TWEET_RESPONSE_BYTES) {
    throw new TweetFetchError("tweet response was too large");
  }
  if (!response.ok) {
    throw new TweetFetchError(`tweet fetch failed: HTTP ${response.status}`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_TWEET_RESPONSE_BYTES) {
    throw new TweetFetchError("tweet response was too large");
  }
  return body;
}

export interface TweetLookup {
  snapshot: TweetSnapshot | null;
  payload: unknown;
  /** True when the answer came from `tweet_cache`. */
  cached: boolean;
}

/**
 * The cache-first path used by hydration: a fresh `resolved` row is returned
 * as it is, and every fetch — successful or not — is written back so a deleted
 * post is not refetched on every render.
 */
export async function lookupTweet(
  db: SessionDatabase,
  doFetch: typeof globalThis.fetch,
  id: string,
  token: string,
  now: number = Date.now(),
): Promise<TweetLookup> {
  const cached = tweets.get(db, id);
  if (cached && now - cached.fetchedAt < TWEET_CACHE_TTL_MS) {
    return { snapshot: cached.snapshot, payload: cached.payload, cached: true };
  }
  let body: string;
  try {
    body = await fetchTweetJson(doFetch, id, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tweets.put(db, { tweetId: id, status: "unavailable", failure: message });
    throw error instanceof TweetFetchError ? error : new TweetFetchError(message);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    tweets.put(db, { tweetId: id, status: "unavailable", failure: "invalid payload" });
    throw new TweetFetchError("the tweet response was not valid JSON");
  }
  const snapshot = tweetSnapshotFromSyndication(id, payload);
  tweets.put(db, {
    tweetId: id,
    payload,
    snapshot,
    status: snapshot ? "resolved" : "unavailable",
    ...(snapshot ? {} : { failure: "the post is unavailable" }),
  });
  return { snapshot, payload, cached: false };
}
