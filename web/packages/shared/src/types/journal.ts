// Journal entries: saved links and X posts. Ported from the desktop
// `src/lib/journal.ts`; the hidden legacy `note` kind is dropped.
//
// Tweet entries separate what the user gave us (`url`, `tweetId` — permanent)
// from what hydration fetched (`tweet` — replaceable), so a re-fetch or a
// failed fetch never loses the entry itself.

import { z } from "zod";

import { tweetSnapshotSchema } from "./tweet.js";

const journalEntryBaseShape = {
  id: z.string(),
  /** ISO timestamp of when the entry was added to the journal. */
  createdAt: z.string(),
};

/** A saved URL that is not a tweet permalink. */
export const journalLinkEntrySchema = z.object({
  ...journalEntryBaseShape,
  kind: z.literal("link"),
  url: z.string(),
});

export type JournalLinkEntry = z.infer<typeof journalLinkEntrySchema>;

export const journalTweetHydrationSchema = z.enum(["pending", "ok", "failed"]);

export type JournalTweetHydration = z.infer<typeof journalTweetHydrationSchema>;

/** A tweet permalink, hydrated (or awaiting hydration) into a snapshot. */
export const journalTweetEntrySchema = z.object({
  ...journalEntryBaseShape,
  kind: z.literal("tweet"),
  /** The permalink as entered; the normalized `tweet.url` may differ. */
  url: z.string(),
  tweetId: z.string(),
  hydration: journalTweetHydrationSchema,
  tweet: tweetSnapshotSchema.optional(),
  /** Why the last hydration failed, when `hydration` is `failed`. */
  error: z.string().optional(),
});

export type JournalTweetEntry = z.infer<typeof journalTweetEntrySchema>;

export const journalEntrySchema = z.discriminatedUnion("kind", [
  journalLinkEntrySchema,
  journalTweetEntrySchema,
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;
