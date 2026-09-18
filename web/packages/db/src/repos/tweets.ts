// The syndication cache behind tweet hydration
// (`docs/02-domain-model-and-database.md` §3.4).
//
// Keyed by tweet id and shared across accounts: the payload is public and
// identical for everyone, and the row records nothing about who asked.

import type { TweetSnapshot } from "@session/shared";
import { MAX_TWEET_SNAPSHOT_BYTES, tweetSnapshotSchema } from "@session/shared";
import { eq, lt } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { parseNullableJsonColumn } from "../json.js";
import { tweetCache } from "../schema/tweets.js";
import { now } from "../time.js";

/** Cap on the stored raw payload, matching the proxy's response limit. */
export const MAX_TWEET_PAYLOAD_BYTES = 1024 * 1024;

export interface CachedTweet {
  tweetId: string;
  payload: unknown;
  snapshot: TweetSnapshot | null;
  fetchedAt: number;
  status: "resolved" | "unavailable";
  failure: string | null;
}

export function get(db: SessionDatabase, tweetId: string): CachedTweet | null {
  const row = db.select().from(tweetCache).where(eq(tweetCache.tweetId, tweetId)).get();
  if (!row) {
    return null;
  }
  return {
    tweetId: row.tweetId,
    payload: row.payloadJson,
    snapshot: parseNullableJsonColumn(
      tweetSnapshotSchema,
      row.snapshotJson,
      "tweet_cache.snapshot_json",
    ),
    fetchedAt: row.fetchedAt,
    status: row.status,
    failure: row.failure,
  };
}

export interface PutTweetInput {
  tweetId: string;
  payload?: unknown;
  snapshot?: TweetSnapshot | null | undefined;
  status: "resolved" | "unavailable";
  failure?: string | null | undefined;
}

export function put(db: SessionDatabase, input: PutTweetInput): CachedTweet {
  if (
    input.payload !== undefined &&
    Buffer.byteLength(JSON.stringify(input.payload ?? null), "utf8") > MAX_TWEET_PAYLOAD_BYTES
  ) {
    throw new Error("Tweet syndication payload exceeds maximum cacheable size.");
  }
  if (
    input.snapshot &&
    Buffer.byteLength(JSON.stringify(input.snapshot), "utf8") > MAX_TWEET_SNAPSHOT_BYTES
  ) {
    throw new Error("Tweet snapshot exceeds maximum cacheable size.");
  }
  const at = now();
  const values = {
    tweetId: input.tweetId,
    payloadJson: input.payload ?? null,
    snapshotJson: input.snapshot ?? null,
    fetchedAt: at,
    status: input.status,
    failure: input.failure ?? null,
  };
  db.insert(tweetCache)
    .values(values)
    .onConflictDoUpdate({ target: tweetCache.tweetId, set: values })
    .run();
  return {
    tweetId: input.tweetId,
    payload: values.payloadJson,
    snapshot: input.snapshot ?? null,
    fetchedAt: at,
    status: input.status,
    failure: input.failure ?? null,
  };
}

/** Drops entries fetched before `before`, so a failed fetch is retried and a
 * deleted post stops being served from a stale row. */
export function prune(db: SessionDatabase, before: number): number {
  return db
    .delete(tweetCache)
    .where(lt(tweetCache.fetchedAt, before))
    .returning({ tweetId: tweetCache.tweetId })
    .all().length;
}
