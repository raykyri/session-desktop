// `feed` (`03-api-and-events.md` §2, `10-home-feed-journal.md` §2).

import { feeds } from "@session/db";
import { recentActivityCursorSchema, recentResearchQueryCursorSchema } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, publicProcedure, router } from "../base.js";
import { catalogUserId } from "../catalog.js";
import { repo } from "../errors.js";

export const feedRouter = router({
  recentActivity: publicProcedure
    .input(
      z
        .object({
          scope: z.enum(["all", "mine", "workspace"]).optional(),
          workspaceId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          before: recentActivityCursorSchema.nullish(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => {
      const scope = input?.scope ?? (ctx.user === null ? "all" : "workspace");
      if (ctx.user === null && scope !== "all") {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in to read this feed" });
      }
      return repo(() =>
        feeds.recentActivity(ctx.db, ctx.user?.id ?? null, {
          scope,
          workspaceId: input?.workspaceId ?? null,
          ...(input?.limit === undefined ? {} : { limit: input.limit }),
          before: input?.before ?? null,
        }),
      );
    }),

  recentQueries: publicProcedure
    .input(
      z
        .object({
          workspaceId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          before: recentResearchQueryCursorSchema.nullish(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => {
      const userId = catalogUserId(ctx);
      if (userId === null) return { items: [], nextCursor: null };
      return repo(() =>
        feeds.recentQueries(ctx.db, userId, {
          workspaceId: input?.workspaceId ?? null,
          ...(input?.limit === undefined ? {} : { limit: input.limit }),
          before: input?.before ?? null,
        }),
      );
    }),

  /** The root entries of the signed-in account's named threads, for the Home
   * cards the newest feed page did not include (the desktop's
   * `list_recent_activity_for_trees`). */
  recentQueriesForTrees: protectedProcedure
    .input(z.object({ treeIds: z.array(z.string()).max(feeds.MAX_FEED_TREE_IDS) }))
    .query(({ ctx, input }) =>
      repo(() => feeds.recentQueriesForTrees(ctx.db, ctx.user.id, input.treeIds)),
    ),
});
