// `journal` and `feed` (`03-api-and-events.md` §2,
// `10-home-feed-journal-encyclopedia.md` §3).

import { feeds, journal, newId } from "@session/db";
import type { JournalEntry, JournalTweetEntry } from "@session/shared";
import {
  applyJournalTweetHydration,
  journalEntrySchema,
  recentActivityCursorSchema,
  recentResearchQueryCursorSchema,
  syndicationToken,
  tweetIdFromUrl,
} from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { TweetFetchError, fetchTweetJson, lookupTweet } from "../../journal/tweets.js";
import { RATE_LIMITS } from "../../middleware/rateLimit.js";
import { protectedProcedure, router } from "../base.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

/** Only web URLs are storable; a `javascript:` or `file:` URL is refused at
 * the door rather than rendered later behind `safeHref`. */
function webUrl(value: string): string {
  const url = URL.parse(value.trim());
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "that does not look like a link" });
  }
  return url.toString();
}

function isTweetEntry(entry: JournalEntry): entry is JournalTweetEntry {
  return entry.kind === "tweet";
}

/**
 * The entry as it may be stored.
 *
 * `add` is not the only way a row reaches the table: `restore` hands back a row
 * the client was holding and `update` replaces one outright, and both take the
 * whole entry from the caller. Without this, the one validation `add` performs
 * is trivially bypassed and a `javascript:` URL is stored for the renderer to
 * defend against later. The hydrated snapshot's own permalink is checked for
 * the same reason; its remaining URLs are produced by
 * `tweetSnapshotFromSyndication`, which drops anything that is not a web URL.
 */
function storableEntry(entry: JournalEntry): JournalEntry {
  const url = webUrl(entry.url);
  if (!isTweetEntry(entry)) return { ...entry, url };
  const tweet = entry.tweet;
  return {
    ...entry,
    url,
    ...(tweet ? { tweet: { ...tweet, url: webUrl(tweet.url) } } : {}),
  };
}

export const journalRouter = router({
  /** The composer accepts a bare URL; whether it becomes a tweet card or a
   * link card is the server's call (`10` §3). */
  add: protectedProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const url = webUrl(input.url);
      const tweetId = tweetIdFromUrl(url);
      const base = { id: newId(), createdAt: new Date().toISOString() };
      let entry: JournalEntry = tweetId
        ? { ...base, kind: "tweet", url, tweetId, hydration: "pending" }
        : { ...base, kind: "link", url };
      entry = repo(() => journal.add(ctx.db, ctx.user.id, entry));
      publish(ctx, "journal.entry.updated", { entry });

      if (isTweetEntry(entry)) {
        // Hydration is attempted immediately and its failure is recorded on
        // the entry rather than raised: the link is worth keeping either way.
        const hydrated = await hydrate(ctx, entry);
        if (hydrated !== entry) {
          publish(ctx, "journal.entry.updated", { entry: hydrated });
          return hydrated;
        }
      }
      return entry;
    }),

  restore: protectedProcedure
    .input(z.object({ entry: journalEntrySchema }))
    .mutation(({ ctx, input }) => {
      const entry = storableEntry(input.entry);
      const restored = repo(() => journal.restore(ctx.db, ctx.user.id, entry));
      if (!restored) {
        // The only way an insert-or-update of one's own entry fails is that
        // the id already belongs to another account. Answered as absence, and
        // published to nobody (`06-auth-and-users.md` §4).
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `journal entry ${entry.id} was not found`,
        });
      }
      publish(ctx, "journal.entry.updated", { entry });
      return restored;
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string(), entry: journalEntrySchema }))
    .mutation(({ ctx, input }) => {
      const entry = storableEntry(input.entry);
      const updated = repo(() => journal.update(ctx.db, ctx.user.id, input.id, entry));
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `journal entry ${input.id} was not found`,
        });
      }
      publish(ctx, "journal.entry.updated", { entry });
      return updated;
    }),

  remove: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    // Checked before the delete so an entry of another account's answers the
    // same way an absent one does, rather than `false` — which reads to the
    // client as "already gone" and is a different answer from "not yours".
    required(
      repo(() => journal.get(ctx.db, ctx.user.id, input.id)),
      `journal entry ${input.id} was not found`,
    );
    const removed = repo(() => journal.remove(ctx.db, ctx.user.id, input.id));
    if (removed) {
      publish(ctx, "journal.entry.removed", { id: input.id });
    }
    return removed;
  }),

  /** The raw syndication body, as the desktop's command returned it. The URL
   * is built from `id` and `token`, never taken from the caller. */
  fetchTweet: protectedProcedure
    .input(z.object({ id: z.string(), token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const budget = ctx.limiter.take(`fetchTweet:${ctx.user.id}`, RATE_LIMITS.fetchTweet);
      if (!budget.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "too many tweet lookups" });
      }
      try {
        return await fetchTweetJson(ctx.fetch, input.id, input.token);
      } catch (error) {
        throw asTrpcError(error);
      }
    }),

  hydrateTweet: protectedProcedure
    .input(z.object({ entryId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const entry = required(
        repo(() => journal.get(ctx.db, ctx.user.id, input.entryId)),
        `journal entry ${input.entryId} was not found`,
      );
      if (!isTweetEntry(entry)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "this entry is not a post" });
      }
      const hydrated = await hydrate(ctx, entry);
      publish(ctx, "journal.entry.updated", { entry: hydrated });
      return hydrated;
    }),
});

type JournalContext = Parameters<typeof publish>[0];

function asTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TweetFetchError && message.startsWith("invalid tweet")) {
    return new TRPCError({ code: "BAD_REQUEST", message });
  }
  return new TRPCError({ code: "BAD_GATEWAY", message });
}

/** One hydration attempt, written through to the entry and the tweet cache. */
async function hydrate(ctx: JournalContext, entry: JournalTweetEntry): Promise<JournalTweetEntry> {
  let next: JournalTweetEntry;
  try {
    const result = await lookupTweet(
      ctx.db,
      ctx.fetch,
      entry.tweetId,
      syndicationToken(entry.tweetId),
    );
    next = applyJournalTweetHydration(
      entry,
      result.snapshot
        ? { hydration: "ok", tweet: result.snapshot }
        : { hydration: "failed", error: "this post is unavailable" },
    );
  } catch (error) {
    next = applyJournalTweetHydration(entry, {
      hydration: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  repo(() => journal.update(ctx.db, ctx.user.id, entry.id, next));
  return next;
}

export const feedRouter = router({
  recentActivity: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          before: recentActivityCursorSchema.nullish(),
          bookmarkedOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      repo(() =>
        feeds.recentActivity(ctx.db, ctx.user.id, {
          workspaceId: input?.workspaceId ?? null,
          ...(input?.limit === undefined ? {} : { limit: input.limit }),
          before: input?.before ?? null,
          ...(input?.bookmarkedOnly === undefined ? {} : { bookmarkedOnly: input.bookmarkedOnly }),
        }),
      ),
    ),

  recentQueries: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          before: recentResearchQueryCursorSchema.nullish(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      repo(() =>
        feeds.recentQueries(ctx.db, ctx.user.id, {
          workspaceId: input?.workspaceId ?? null,
          ...(input?.limit === undefined ? {} : { limit: input.limit }),
          before: input?.before ?? null,
        }),
      ),
    ),
});
