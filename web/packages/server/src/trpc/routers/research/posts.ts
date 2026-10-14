// `research.*` procedures on posts: notes and saved links the user writes
// (the desktop's `create_research_post`, `create_research_post_follow_up`,
// `update_research_post`), on `repos/posts.ts` in `@session/db`.
//
// A post has no run, so none of these is subject to admission or the daily
// limits. The X posts a note links to are resolved before it is written, as
// for a question (`journal/attachments.ts`), and `hydratePostTweet` asks
// again for the ones that could not be read.

import { feedItems, posts } from "@session/db";
import type { ResearchNode, ResearchTreeDetail, UpdateResearchPostResult } from "@session/shared";
import { canUseModel, findModel, tweetAttachment } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { resolveMessageAttachments } from "../../../journal/attachments.js";
import { resolveTweet } from "../../../journal/tweets.js";
import { requireNodeRole } from "../../../research/access.js";
import { resolveImageAttachments } from "../../../research/images.js";
import { notifyNewNode } from "../../../research/notifications.js";
import { protectedProcedure } from "../../base.js";
import { publish, publishToTree } from "../../emit.js";
import { repo, required } from "../../errors.js";

import { publishNode, publishTree } from "./common.js";

/** The registry model and effort a note's AI follow-ups default to. A note
 * never runs, so the deployment need not be able to reach the model; the
 * account must be allowed to use it. */
function followUpAgent(
  user: Parameters<typeof canUseModel>[0],
  modelId: string,
  effort: string | null | undefined,
): { model: string; effort: string | null } {
  const model = findModel(modelId);
  if (!model || !canUseModel(user, modelId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${modelId} is not available on this account`,
    });
  }
  if (effort !== null && effort !== undefined && !(model.efforts as string[]).includes(effort)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${model.label} does not take the ${effort} effort`,
    });
  }
  return { model: model.id, effort: effort ?? null };
}

/** Emits the feed update for the thread a post change touched, so its Home
 * card shows the new text or the new follow-up. */
function refreshFeedCard(ctx: Parameters<typeof emitFeedItemUpsertedForNode>[0], treeId: string) {
  const item = feedItems.forTree(ctx.db, treeId);
  if (item) emitFeedItemUpsertedForNode(ctx, item.id);
}

export const postProcedures = {
  createPost: protectedProcedure
    .input(
      z.object({
        body: z.string().min(1),
        workspaceId: z.string(),
        model: z.string(),
        effort: z.string().nullish(),
        /** Ids from `POST /api/images`. */
        images: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ResearchTreeDetail> => {
      const agent = followUpAgent(ctx.user, input.model, input.effort);
      const images = resolveImageAttachments(ctx.db, ctx.user.id, input.images);
      const tweets = await resolveMessageAttachments(
        { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
        input.body,
      );
      const detail = repo(() =>
        posts.admitPost(ctx.db, ctx.user.id, {
          workspaceId: input.workspaceId,
          text: input.body,
          attachments: [...tweets, ...images],
          agent,
        }),
      );
      const root = required(detail.nodes[0], "the new thread has no root node");
      publish(ctx, "research.tree.created", { tree: detail.tree, node: root });
      emitFeedItemUpsertedForNode(ctx, root.id);
      return detail;
    }),

  createPostFollowUp: protectedProcedure
    .input(z.object({ parentNodeId: z.string(), body: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<ResearchNode> => {
      // A viewer is refused before the note's links are fetched.
      requireNodeRole(ctx, input.parentNodeId, "commenter");
      const tweets = await resolveMessageAttachments(
        { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
        input.body,
      );
      const node = repo(() =>
        posts.admitFollowUpNote(ctx.db, ctx.user.id, input.parentNodeId, input.body, tweets),
      );
      publishToTree(ctx, node.treeId, "research.node.created", { node });
      refreshFeedCard(ctx, node.treeId);
      notifyNewNode(ctx, ctx.user.id, node);
      return node;
    }),

  updatePost: protectedProcedure
    .input(z.object({ nodeId: z.string(), text: z.string(), expectedText: z.string() }))
    .mutation(({ ctx, input }): UpdateResearchPostResult => {
      const result = repo(() => posts.updatePost(ctx.db, ctx.user.id, input));
      publishNode(ctx, result.node);
      if (result.titleChanged) {
        publishTree(ctx, "research.tree.updated", result.tree);
      }

      refreshFeedCard(ctx, result.tree.id);
      return {
        tree: result.tree,
        node: result.node,
        removedHighlightCount: result.removedHighlightCount,
      };
    }),

  /** Asks again for the X posts a note carries that were unavailable when it
   * was written (a timeout, a rate limit, a post since restored). A post
   * already resolved is left as it is. */
  hydratePostTweet: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<ResearchNode> => {
      const message = repo(() => posts.message(ctx.db, ctx.user.id, input.nodeId));
      const unavailable = (message.attachments ?? []).flatMap((attachment) =>
        attachment.kind === "tweet" && attachment.status === "unavailable" ? [attachment] : [],
      );
      if (unavailable.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This note has no unavailable X post to load again.",
        });
      }
      const deps = { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger };
      const attemptedAt = Date.now();
      const replacements = await Promise.all(
        unavailable.map(async (attachment) => {
          const resolved = await resolveTweet(deps, attachment.tweetId, {
            handle: URL.parse(attachment.sourceUrl)?.pathname.split("/").find(Boolean),
            retryUnavailable: true,
          });
          return tweetAttachment(
            // `tweetAttachment` reads no offsets; the attachment stores none.
            {
              sourceUrl: attachment.sourceUrl,
              tweetId: attachment.tweetId,
              placement: attachment.placement,
              start: 0,
              end: 0,
            },
            resolved.status === "resolved" && resolved.snapshot && resolved.provider
              ? {
                  status: "resolved",
                  provider: resolved.provider,
                  tweet: resolved.snapshot,
                  fetchedAt: resolved.fetchedAt,
                }
              : { status: "unavailable", failure: resolved.failureKind ?? "network" },
            attemptedAt,
          );
        }),
      );
      const node = repo(() =>
        posts.replaceTweetAttachments(ctx.db, ctx.user.id, input.nodeId, replacements),
      );
      publishNode(ctx, node);
      refreshFeedCard(ctx, node.treeId);
      return node;
    }),
};
