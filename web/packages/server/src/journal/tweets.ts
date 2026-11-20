// Tweet hydration pipeline (`03-api-and-events.md` §2, `journal.rs:142-187`).
//
// Performs server-side tweet fetching for journal entries and research post
// links (`attachments.ts`). The syndication CDN CORS policy allows only
// `platform.twitter.com`, requiring server-side fetching and centralized caching.
//
// Attempts resolution in two stages:
// 1. `cdn.syndication.twimg.com`: returns full post data (media, quoted posts,
//    link cards, interaction counts).
// 2. `publish.twitter.com/oembed` (`oembed.ts`): fallback for posts no longer
//    served by syndication, returning author, text, and date without media.
// The resolved provider is recorded to distinguish intentionally reduced
// representations from missing assets.

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
import { ResponseTooLargeError, readCappedText } from "../net/readCapped.js";

import { fetchTweetOembed, tweetSnapshotFromOembed } from "./oembed.js";

const SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";

/** Maximum response payload size (1 MiB), matching `tweet_cache.payload_json` limits. */
export const MAX_TWEET_RESPONSE_BYTES = 1024 * 1024;

/** Syndication CDN fetch timeout in milliseconds. */
export const TWEET_FETCH_TIMEOUT_MS = 10_000;

/** Cache TTL for successful or definite resolution responses. */
export const TWEET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const OVERSIZED_RESPONSE = "Tweet response exceeds maximum allowed size";

/** TTL for transient errors (timeouts, network errors) to prevent stampedes while permitting retries. */
export const TWEET_TRANSIENT_FAILURE_TTL_MS = 60 * 1000;

/** Returns the cache TTL for a cached row based on resolution status and failure classification. */
function cacheLifetime(cached: { status: string; failure: string | null }): number {
  if (cached.status === "resolved") {
    return TWEET_CACHE_TTL_MS;
  }
  const failure = cached.failure ?? "";
  const kind = classifyTweetFetchFailure(failure);
  const transient =
    kind === "timeout" || (kind === "network" && !failure.includes(OVERSIZED_RESPONSE));
  return transient ? TWEET_TRANSIENT_FAILURE_TTL_MS : TWEET_CACHE_TTL_MS;
}

export class TweetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TweetFetchError";
  }
}

/** Matches numeric status IDs of up to 25 digits. */
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

/** Fetches raw syndication response text, rejecting responses that exceed
 * the maximum byte limit. */
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
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TweetFetchError(`Tweet fetch request failed with HTTP ${response.status}.`);
  }
  try {
    return await readCappedText(response, MAX_TWEET_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new TweetFetchError(OVERSIZED_RESPONSE);
    }
    throw error;
  }
}

/** Result of a tweet hydration attempt. `failure` contains the display error
 * message stored in `tweet_cache`; `failureKind` classifies the failure for
 * attachment metadata. */
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

/** User-facing message displayed when a post cannot be retrieved. */
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

/** Attempts resolution via syndication CDN, returning snapshot or error status. */
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
    return { snapshot: null, payload: null, failure: "Tweet response was not valid JSON" };
  }
  const snapshot = tweetSnapshotFromSyndication(id, payload);
  // Deleted, withheld, and protected posts return a `TweetTombstone` payload
  // representing post status rather than a network error.
  return { snapshot, payload, failure: snapshot ? null : TWEET_UNAVAILABLE_MESSAGE };
}

/** Attempts resolution via oEmbed fallback. */
async function fromOembed(
  deps: TweetHydrationDeps,
  id: string,
  handle: string | undefined,
): Promise<{ snapshot: TweetSnapshot | null; payload: unknown }> {
  try {
    const payload = await fetchTweetOembed(deps.fetch, id, handle);
    return { snapshot: await tweetSnapshotFromOembed(id, payload), payload };
  } catch (error) {
    deps.logger?.debug({ tweetId: id, error }, "oEmbed fallback failed to resolve post");
    return { snapshot: null, payload: null };
  }
}

/**
 * Persists the resolution attempt to `tweet_cache`, logging write failures.
 * Cache write failures do not interrupt successful resolutions.
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

/** Registers snapshot images for `/embeds/<hash>`. If image registration
 * fails, image URLs retain their origin targets so the card can still render. */
function withCachedImages(deps: TweetHydrationDeps, snapshot: TweetSnapshot): TweetSnapshot {
  try {
    return cacheSnapshotImages(deps.db, snapshot);
  } catch (error) {
    deps.logger?.warn({ tweetId: snapshot.id, error }, "could not register a post's images");
    return snapshot;
  }
}

/**
 * Cache-first hydration: cached rows within TTL are returned directly, and
 * resolution outcomes are cached to prevent repeated requests for missing posts.
 * Returns a resolution result rather than throwing to allow callers to persist
 * outcome metadata.
 *
 * Stored snapshots have images rewritten to `/embeds/<hash>` (`embeds/storage.ts`),
 * registering them for local serving.
 */
export async function resolveTweet(
  deps: TweetHydrationDeps,
  id: string,
  options: {
    now?: number;
    handle?: string | undefined;
    /** Bypass cached unavailable status on explicit retry (`research.hydratePostTweet`). */
    retryUnavailable?: boolean;
  } = {},
): Promise<TweetResolution> {
  const now = options.now ?? Date.now();
  // Validates tweet ID format before contacting upstream providers.
  if (!TWEET_ID.test(id)) {
    return unavailable("Invalid tweet ID.", false, now);
  }
  const cached = tweets.get(deps.db, id);
  const reuse =
    cached !== null &&
    now - cached.fetchedAt < cacheLifetime(cached) &&
    !(options.retryUnavailable === true && cached.status !== "resolved");
  if (cached && reuse) {
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
  // The fallback is invoked only when syndication returns an explicit error or
  // unavailable status (e.g. 404, rate limit, tombstone). Timeouts indicate
  // upstream connectivity failures where a secondary request would compound latency.
  if (!snapshot && classifyTweetFetchFailure(syndication.failure ?? "") !== "timeout") {
    const fallback = await fromOembed(deps, id, options.handle);
    if (fallback.snapshot) {
      snapshot = fallback.snapshot;
      payload = fallback.payload;
      provider = "xOembed";
    }
  }

  if (!snapshot) {
    // Reports the syndication error message, which provides more specific status details.
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
