// `highlights` and `recaps` (`03-api-and-events.md` §2).

import { highlights, nodes, recaps } from "@session/db";
import {
  DEFAULT_RECAP_INSTRUCTIONS,
  researchHighlightAnchorSchema,
  researchRecapCandidateSchema,
  validateRecapInstructions,
} from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, publicProcedure, router } from "../base.js";
import { catalogUserId } from "../catalog.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

export const highlightsRouter = router({
  create: protectedProcedure
    .input(z.object({ nodeId: z.string(), anchor: researchHighlightAnchorSchema }))
    .mutation(({ ctx, input }) => {
      const highlight = repo(() =>
        highlights.create(ctx.db, ctx.user.id, input.nodeId, input.anchor),
      );
      publish(ctx, "research.highlight.created", { nodeId: input.nodeId, highlight });
      return highlight;
    }),

  remove: protectedProcedure
    .input(z.object({ nodeId: z.string(), highlightId: z.string() }))
    .mutation(({ ctx, input }) => {
      const highlight = repo(() =>
        highlights.remove(ctx.db, ctx.user.id, input.nodeId, input.highlightId),
      );
      publish(ctx, "research.highlight.removed", {
        nodeId: input.nodeId,
        highlightId: input.highlightId,
      });
      return highlight;
    }),

  removeMany: protectedProcedure
    .input(z.object({ nodeId: z.string(), highlightIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      // The delete is already scoped to the account, so a foreign id removes
      // nothing; the node is checked so the *answer* matches `remove`'s —
      // `NOT_FOUND` for someone else's node rather than a silent empty list
      // that reads like a successful no-op (`06-auth-and-users.md` §4).
      required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      const removed = repo(() =>
        highlights.removeMany(ctx.db, ctx.user.id, input.nodeId, input.highlightIds),
      );
      publish(ctx, "research.highlights.removed", {
        nodeId: input.nodeId,
        highlightIds: removed.map((highlight) => highlight.id),
      });
      return removed;
    }),

  listFeed: publicProcedure
    .input(z.object({ workspaceId: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      const userId = catalogUserId(ctx);
      if (userId === null) return [];
      return repo(() => highlights.feed(ctx.db, userId, input?.workspaceId ?? null));
    }),
});

export const recapsRouter = router({
  defaultInstructions: publicProcedure.query(() => DEFAULT_RECAP_INSTRUCTIONS),

  /**
   * A `gemini-flash` metadata run the dialog waits on
   * (`04-agent-runtime.md` §9).
   *
   * The candidate is returned rather than saved: the user previews it and
   * `applyCandidate` is what commits it. Unlike the automatic recap, a refusal
   * here is reported — someone asked for this one and is waiting.
   */
  generateCandidate: protectedProcedure
    .input(
      z.object({
        nodeId: z.string(),
        expectedResponseRevision: z.string(),
        instructions: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const instructions = repo(() => validateRecapInstructions(input.instructions));
      publish(ctx, "research.recap.pending", { nodeId: input.nodeId, pending: true });
      try {
        const candidate = await ctx.runs.requestRecapCandidate(
          ctx.user.id,
          input.nodeId,
          instructions,
        );
        if (candidate.responseRevision !== input.expectedResponseRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The answer changed while the summary was generated. Please try again.",
          });
        }
        return candidate;
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Every exit path settles the flag (`04-agent-runtime.md` §9).
        publish(ctx, "research.recap.pending", { nodeId: input.nodeId, pending: false });
      }
    }),

  applyCandidate: protectedProcedure
    .input(
      z.object({
        nodeId: z.string(),
        expectedResponseRevision: z.string(),
        expectedCurrentRecapId: z.string().nullish(),
        candidate: researchRecapCandidateSchema,
      }),
    )
    .mutation(({ ctx, input }) => {
      // Use the cached server candidate when available so clients cannot alter
      // generated recap content before it is stored.
      const issued = ctx.runs.recallRecapCandidate(ctx.user.id, input.candidate.id);
      const node = repo(() =>
        recaps.applyCandidate(ctx.db, ctx.user.id, {
          nodeId: input.nodeId,
          expectedResponseRevision: input.expectedResponseRevision,
          ...(input.expectedCurrentRecapId === undefined
            ? {}
            : { expectedCurrentRecapId: input.expectedCurrentRecapId }),
          candidate: issued ?? input.candidate,
        }),
      );
      publish(ctx, "research.node.updated", { node });
      // Every exit path settles the pending flag (`04-agent-runtime.md` §9).
      publish(ctx, "research.recap.pending", { nodeId: input.nodeId, pending: false });
      return node;
    }),
});
