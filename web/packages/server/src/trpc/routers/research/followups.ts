// The follow-up queue (`followups.*`): questions asked at the end of an
// inline chain, sent at once when the chain can take them and queued on the
// server otherwise, then sent in order as the chain frees up
// (`research/followups.ts`). It replaces the desktop's client-side queue, so a
// question asked while an answer is still running is no longer refused.

import type { SessionDatabase } from "@session/db";
import { followups, trees } from "@session/db";
import type { ResearchFollowupQueueItem, ResearchNode } from "@session/shared";
import { nodeEffort, nodeModelId } from "@session/shared";
import { z } from "zod";

import { resolveMessageAttachments } from "../../../journal/attachments.js";
import { requireNodeRole } from "../../../research/access.js";
import {
  assertEffortAccepted,
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
} from "../../../research/admission.js";
import { publishAdmittedFollowup, publishQueue } from "../../../research/followups.js";
import { assertModelReadsImages, resolveImageAttachments } from "../../../research/images.js";
import { protectedProcedure } from "../../base.js";
import { repo, required } from "../../errors.js";

import { dispatchFollowups } from "./common.js";

export type AskFollowupResult =
  { kind: "sent"; node: ResearchNode } | { kind: "queued"; item: ResearchFollowupQueueItem };

/** The last node of the chain `nodeId` belongs to: the node a follow-up sent
 * now would continue, and whose agent an unspecified one inherits. Reads the
 * chain alone (`followups.chainTail`), not the thread's detail. */
function chainTail(ctx: { db: SessionDatabase }, userId: string, nodeId: string): ResearchNode {
  return required(
    repo(() => followups.chainTail(ctx.db, userId, nodeId)),
    `research node ${nodeId} was not found`,
  );
}

export const followupProcedures = {
  /**
   * Asks a follow-up at the end of the chain `headNodeId` belongs to. Sent at
   * once when nothing is queued for the chain and its last answer is
   * complete; queued otherwise. `model` and `effort` default to the chain's
   * last node's agent; a different model without an effort runs at that
   * model's default effort.
   */
  ask: protectedProcedure
    .input(
      z.object({
        headNodeId: z.string(),
        prompt: z.string().min(1),
        model: z.string().optional(),
        effort: z.string().nullish(),
        /** Ids from `POST /api/images`, resolved now and stored on the queued
         * item's message. */
        images: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AskFollowupResult> => {
      // A viewer cannot ask; refused before anything is resolved or charged.
      requireNodeRole(ctx, input.headNodeId, "commenter");
      const tail = chainTail(ctx, ctx.user.id, input.headNodeId);
      const model = input.model ?? nodeModelId(tail);
      const effort =
        input.effort !== undefined
          ? input.effort
          : model === nodeModelId(tail)
            ? nodeEffort(tail)
            : null;
      assertModelUsable(ctx, model);
      assertEffortAccepted(model, effort);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const images = resolveImageAttachments(ctx.db, ctx.user.id, input.images);
      assertModelReadsImages(model, images);
      const attachments = [
        ...(await resolveMessageAttachments(
          { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
          input.prompt,
        )),
        ...images,
      ];
      const result = repo(() =>
        followups.ask(ctx.db, ctx.user.id, {
          headNodeId: input.headNodeId,
          message: {
            text: input.prompt,
            ...(attachments.length === 0 ? {} : { attachments }),
          },
          agent: { model, effort },
          ...(ctx.user.isAdmin ? {} : { maxQueued: ctx.config.limits.queuedPerUser }),
        }),
      );
      if (result.kind === "sent") {
        publishAdmittedFollowup(ctx, ctx.user.id, result.node);
        ctx.runs.start(result.node.id);
        return { kind: "sent", node: result.node };
      }
      publishQueue(ctx, ctx.user.id, result.item.treeId, result.headNodeId);
      return { kind: "queued", item: result.item };
    }),

  /** Removes a queued follow-up. Returns the chain's queue after it. */
  cancel: protectedProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(({ ctx, input }): ResearchFollowupQueueItem[] => {
      const item = repo(() => followups.cancel(ctx.db, ctx.user.id, input.itemId));
      publishQueue(ctx, ctx.user.id, item.treeId, item.headNodeId);
      // The cancelled item may have been a refused one the queue waited on.
      dispatchFollowups(ctx, item.treeId);
      return repo(() => followups.listForHead(ctx.db, ctx.user.id, item.headNodeId));
    }),

  /** Clears a refused follow-up's reason and tries to send the queue again.
   * Returns the chain's queue after it; the item is gone from it when it was
   * sent. */
  retry: protectedProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(({ ctx, input }): ResearchFollowupQueueItem[] => {
      const item = repo(() => followups.retry(ctx.db, ctx.user.id, input.itemId));
      publishQueue(ctx, ctx.user.id, item.treeId, item.headNodeId);
      dispatchFollowups(ctx, item.treeId);
      return repo(() => followups.listForHead(ctx.db, ctx.user.id, item.headNodeId));
    }),

  /** A thread's queues, keyed by chain head, each in send order. */
  list: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .query(({ ctx, input }): Record<string, ResearchFollowupQueueItem[]> => {
      required(
        repo(() => trees.get(ctx.db, ctx.user.id, input.treeId)),
        `research tree ${input.treeId} was not found`,
      );
      return repo(() => followups.listForTree(ctx.db, ctx.user.id, input.treeId));
    }),
};
