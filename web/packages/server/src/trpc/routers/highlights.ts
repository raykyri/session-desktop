// `highlights` and `recaps` (`03-api-and-events.md` §2).

import { highlights, recaps } from "@session/db";
import {
  DEFAULT_RECAP_INSTRUCTIONS,
  researchHighlightAnchorSchema,
  researchRecapCandidateSchema,
  validateRecapInstructions,
} from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, router } from "../base.js";
import { publish } from "../emit.js";
import { repo } from "../errors.js";

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
      const removed = repo(() =>
        highlights.removeMany(ctx.db, ctx.user.id, input.nodeId, input.highlightIds),
      );
      publish(ctx, "research.highlights.removed", {
        nodeId: input.nodeId,
        highlightIds: removed.map((highlight) => highlight.id),
      });
      return removed;
    }),

  listFeed: protectedProcedure
    .input(z.object({ workspaceId: z.string().optional() }).optional())
    .query(({ ctx, input }) =>
      repo(() => highlights.feed(ctx.db, ctx.user.id, input?.workspaceId ?? null)),
    ),
});

export const recapsRouter = router({
  defaultInstructions: protectedProcedure.query(() => DEFAULT_RECAP_INSTRUCTIONS),

  /**
   * Generation is a `gemini-flash` metadata run and arrives with the agent
   * loop (`04-agent-runtime.md` §9). The input is still validated here so the
   * dialog's copy is settled before Phase 4 fills in the model call.
   */
  generateCandidate: protectedProcedure
    .input(
      z.object({
        nodeId: z.string(),
        expectedResponseRevision: z.string(),
        instructions: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => {
      repo(() => validateRecapInstructions(input.instructions));
      ctx.runs.enqueueMetadata({
        kind: "recap",
        userId: ctx.user.id,
        nodeId: input.nodeId,
        instructions: input.instructions,
      });
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "metadata runs arrive in Phase 4",
      });
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
      const node = repo(() =>
        recaps.applyCandidate(ctx.db, ctx.user.id, {
          nodeId: input.nodeId,
          expectedResponseRevision: input.expectedResponseRevision,
          ...(input.expectedCurrentRecapId === undefined
            ? {}
            : { expectedCurrentRecapId: input.expectedCurrentRecapId }),
          candidate: input.candidate,
        }),
      );
      publish(ctx, "research.node.updated", { node });
      // Every exit path settles the pending flag (`04-agent-runtime.md` §9).
      publish(ctx, "research.recap.pending", { nodeId: input.nodeId, pending: false });
      return node;
    }),
});
