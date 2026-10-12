// `artifacts` and `events`
// (`03-api-and-events.md` §2, `11-artifacts-and-browser.md` §2).

import { randomUUID } from "node:crypto";

import { artifacts } from "@session/db";
import type { SessionEvent } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { answerWidgetSource, mintWidgetPreview } from "../../artifacts/widgets.js";
import { nodeContent } from "../../research/admission.js";
import { protectedProcedure, router } from "../base.js";
import { repo, required } from "../errors.js";

export const artifactsRouter = router({
  /** A one-hour preview URL for one widget block of a stored answer the
   * caller can read, named by the SHA-256 of its HTML. The server resolves the
   * HTML from the answer; a client cannot have arbitrary HTML served on the
   * artifact origin. */
  prepareWidget: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().min(1).max(256),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .mutation(({ ctx, input }) => {
      const html = answerWidgetSource(nodeContent(ctx, input.nodeId), input.sha256);
      if (html === null)
        throw new TRPCError({ code: "NOT_FOUND", message: "the answer has no such widget" });
      const minted = mintWidgetPreview(ctx.db, ctx.user.id, html);
      return { url: `${ctx.config.artifactOrigin}/w/${minted.token}`, expiresAt: minted.expiresAt };
    }),
  /** A one-hour, single-document URL on the artifact origin. The client
   * re-mints on 404 or 410 (`11-artifacts-and-browser.md` §2). */
  mintToken: protectedProcedure
    .input(z.object({ documentId: z.string() }))
    .mutation(({ ctx, input }) => {
      const minted = required(
        repo(() => artifacts.mintToken(ctx.db, ctx.user.id, input.documentId)),
        `document ${input.documentId} was not found`,
      );
      return {
        url: `${ctx.config.artifactOrigin}/a/${minted.token}`,
        expiresAt: minted.expiresAt,
      };
    }),
});

export const eventsRouter = router({
  /**
   * The event stream, served as SSE by the fetch adapter. `connectionId` lets
   * the client address its own connection in `setInterest`; when it is absent
   * the server mints one and announces it as the first event so a client that
   * did not generate an id can still declare interest.
   */
  subscribe: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1).max(64).optional() }).optional())
    .subscription(async function* ({ ctx, input, signal }) {
      const connectionId = input?.connectionId ?? randomUUID();
      const subscription = ctx.eventBus.subscribe(ctx.user.id, connectionId, signal);
      try {
        yield {
          type: "connection.ready",
          payload: { connectionId },
          timestamp: Date.now(),
        } satisfies SessionEvent;
        for await (const event of subscription.events) {
          yield event;
        }
      } finally {
        subscription.close();
      }
    }),

  setInterest: protectedProcedure
    .input(z.object({ connectionId: z.string(), nodeIds: z.array(z.string()).max(200) }))
    .mutation(({ ctx, input }) => ({
      // False when the connection has already gone; the client's next
      // subscribe publishes its interest again.
      applied: ctx.eventBus.setInterest(ctx.user.id, input.connectionId, input.nodeIds),
    })),
});
