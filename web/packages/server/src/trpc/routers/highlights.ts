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

import { emitFeedItemUpsertedForNode } from "../../events/feed.js";
import { requireNodeRole, treeIdOfNode } from "../../research/access.js";
import { protectedProcedure, publicProcedure, router } from "../base.js";
import type { EmitterContext } from "../emit.js";
import { publishToTree } from "../emit.js";
import { repo, required } from "../errors.js";

/** `recaps.applyCandidate` for a candidate the server no longer holds (it
 * expired, the server restarted) or never generated for the caller. */
export const RECAP_CANDIDATE_UNAVAILABLE = "This recap is no longer available; generate it again.";

/** A node event to the audience of the node's thread. */
function publishForNode(
  ctx: EmitterContext,
  nodeId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  const treeId = treeIdOfNode(ctx.db, nodeId);
  if (treeId !== null) publishToTree(ctx, treeId, type, payload);
}

export const highlightsRouter = router({
  create: protectedProcedure
    .input(z.object({ nodeId: z.string(), anchor: researchHighlightAnchorSchema }))
    .mutation(({ ctx, input }) => {
      const highlight = repo(() =>
        highlights.create(ctx.db, ctx.user.id, input.nodeId, input.anchor),
      );
      publishForNode(ctx, input.nodeId, "research.highlight.created", {
        nodeId: input.nodeId,
        highlight,
      });
      return highlight;
    }),

  remove: protectedProcedure
    .input(z.object({ nodeId: z.string(), highlightId: z.string() }))
    .mutation(({ ctx, input }) => {
      const highlight = repo(() =>
        highlights.remove(ctx.db, ctx.user.id, input.nodeId, input.highlightId),
      );
      // The desktop has no single-highlight event; one removal is a list of
      // one.
      publishForNode(ctx, input.nodeId, "research.highlights.removed", {
        nodeId: input.nodeId,
        highlightIds: [input.highlightId],
      });
      return highlight;
    }),

  removeMany: protectedProcedure
    .input(z.object({ nodeId: z.string(), highlightIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      // The node is checked so the *answer* matches `remove`'s — `NOT_FOUND`
      // for a node the caller cannot read rather than a silent empty list
      // that reads like a successful no-op (`06-auth-and-users.md` §4).
      required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      const removed = repo(() =>
        highlights.removeMany(ctx.db, ctx.user.id, input.nodeId, input.highlightIds),
      );
      publishForNode(ctx, input.nodeId, "research.highlights.removed", {
        nodeId: input.nodeId,
        highlightIds: removed.map((highlight) => highlight.id),
      });
      return removed;
    }),

  listFeed: publicProcedure
    .input(z.object({ workspaceId: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      // The caller's own threads; a guest has none.
      if (ctx.user === null) return [];
      const userId = ctx.user.id;
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
      // Recaps are shared, and the requester pays for this one: a commenter
      // or the owner, refused before the run.
      const { tree } = requireNodeRole(ctx, input.nodeId, "commenter");
      const instructions = repo(() => validateRecapInstructions(input.instructions));
      publishToTree(ctx, tree.id, "research.recap.pending", {
        nodeId: input.nodeId,
        pending: true,
      });
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
        publishToTree(ctx, tree.id, "research.recap.pending", {
          nodeId: input.nodeId,
          pending: false,
        });
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
      // Only a candidate this server generated for the caller is stored, as
      // the server keeps it, so a client cannot store recap text of its own.
      // Checked after the role, so a viewer is told that instead.
      requireNodeRole(ctx, input.nodeId, "commenter");
      const issued = ctx.runs.recallRecapCandidate(ctx.user.id, input.candidate.id);
      if (issued === null) {
        throw new TRPCError({ code: "CONFLICT", message: RECAP_CANDIDATE_UNAVAILABLE });
      }
      const node = repo(() =>
        recaps.applyCandidate(ctx.db, ctx.user.id, {
          nodeId: input.nodeId,
          expectedResponseRevision: input.expectedResponseRevision,
          ...(input.expectedCurrentRecapId === undefined
            ? {}
            : { expectedCurrentRecapId: input.expectedCurrentRecapId }),
          candidate: issued,
        }),
      );
      publishToTree(ctx, node.treeId, "research.node.updated", { node });
      emitFeedItemUpsertedForNode(ctx, node.id);
      // Every exit path settles the pending flag (`04-agent-runtime.md` §9).
      publishToTree(ctx, node.treeId, "research.recap.pending", {
        nodeId: input.nodeId,
        pending: false,
      });

      return node;
    }),
});
