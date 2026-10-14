// Tweet snapshots as the backend resolves them into research message
// attachments (src-tauri/src/tweets.rs). The types are part of the shared wire
// model; rendering lives in TweetEmbed.
import type { TweetSnapshot } from "@session/shared/wire";

export type { QuotedTweetSnapshot, TweetSnapshot, TweetTextRun } from "@session/shared/wire";

/** The text Home shows in place of a tweet embed: "[Tweet: @handle]" with
 * the author's handle, or "[Tweet]" when the snapshot has none. */
export function tweetLabelText(tweet?: Pick<TweetSnapshot, "author"> | null): string {
  const handle = tweet?.author?.handle?.trim().replace(/^@+/, "");
  return handle ? `[Tweet: @${handle}]` : "[Tweet]";
}
