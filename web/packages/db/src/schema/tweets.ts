// The syndication cache behind tweet hydration
// (`docs/02-domain-model-and-database.md` §3.4). Shared across users: a
// tweet's public payload is the same for everyone, and the cache holds
// nothing about who asked for it.

import type { TweetSnapshot } from "@session/shared";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tweetCache = sqliteTable("tweet_cache", {
  tweetId: text("tweet_id").primaryKey(),
  /** Raw syndication body, ≤ 1 MiB. */
  payloadJson: text("payload_json", { mode: "json" }),
  /** Normalized snapshot, ≤ 128 KiB. Null while a fetch has failed. */
  snapshotJson: text("snapshot_json", { mode: "json" }).$type<TweetSnapshot>(),
  fetchedAt: integer("fetched_at").notNull(),
  status: text("status", { enum: ["resolved", "unavailable"] }).notNull(),
  failure: text("failure"),
});
