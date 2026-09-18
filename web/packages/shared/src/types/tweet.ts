// The hydrated form of an X post, stored on a journal entry or a research
// message attachment. Ported from the desktop `src/lib/journalTweets.ts`.
// The snapshot — not the raw syndication payload — is the persisted format,
// so its shape changes deliberately; `journal/tweets.ts` owns the
// normalization that produces it.

import { z } from "zod";

export const tweetMediaSchema = z.object({
  kind: z.enum(["photo", "video", "gif"]),
  /** Direct https image URL: the photo itself, or the video poster frame. */
  imageUrl: z.string(),
  /** Permalink for watching the video on X (videos and gifs only). */
  watchUrl: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  altText: z.string().optional(),
  durationMillis: z.number().optional(),
});

export type TweetMedia = z.infer<typeof tweetMediaSchema>;

/** One span of the tweet text: plain text, or a t.co entity expanded into a
 * link labeled with its display form. Structured runs rather than markdown so
 * tweet text that happens to contain markdown syntax renders literally. */
export const tweetTextRunSchema = z.object({
  kind: z.enum(["text", "link"]),
  text: z.string(),
  /** Expanded destination, for link runs. */
  url: z.string().optional(),
  /** The t.co this run replaced, so a link card can find the run it stands
   * for. Kept off the wire when absent. */
  tco: z.string().optional(),
});

export type TweetTextRun = z.infer<typeof tweetTextRunSchema>;

/** A link preview the tweet carries — the bordered card X renders under the
 * text for a shared URL. `large` is the wide-image variant. */
export const tweetLinkCardSchema = z.object({
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  large: z.boolean(),
});

export type TweetLinkCard = z.infer<typeof tweetLinkCardSchema>;

const tweetSnapshotCoreSchema = z.object({
  id: z.string(),
  url: z.string(),
  author: z.object({
    name: z.string(),
    handle: z.string(),
    avatarUrl: z.string().optional(),
    /** Carries a verification badge (blue or legacy). */
    verified: z.boolean().optional(),
  }),
  /** ISO timestamp of the tweet itself (not the capture). */
  createdAt: z.string().optional(),
  runs: z.array(tweetTextRunSchema),
  /** True when the payload is a preview of a longer post (full text is not
   * available from the syndication endpoint). */
  partial: z.boolean(),
  media: z.array(tweetMediaSchema),
  card: tweetLinkCardSchema.optional(),
  /** Engagement counts as captured. Absent when the payload omits them. */
  replies: z.number().optional(),
  likes: z.number().optional(),
  possiblySensitive: z.boolean().optional(),
  language: z.string().optional(),
  editIds: z.array(z.string()).optional(),
});

/** A quoted post carries no quote of its own and no reply target. */
export const quotedTweetSnapshotSchema = tweetSnapshotCoreSchema;

export type QuotedTweetSnapshot = z.infer<typeof quotedTweetSnapshotSchema>;

export const tweetSnapshotSchema = tweetSnapshotCoreSchema.extend({
  replyTo: z.object({ handle: z.string(), id: z.string().optional() }).optional(),
  quoted: quotedTweetSnapshotSchema.optional(),
});

export type TweetSnapshot = z.infer<typeof tweetSnapshotSchema>;
