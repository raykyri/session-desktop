// `encyclopedia`, `artifacts`, and `events`
// (`03-api-and-events.md` §2, `11-artifacts-and-browser.md` §2).

import { randomUUID } from "node:crypto";

import { artifacts, encyclopedia } from "@session/db";
import type { SessionEvent } from "@session/shared";
import { encyclopediaPageRequestSchema, validateEncyclopediaSlug } from "@session/shared";
import { z } from "zod";

import { protectedProcedure, router } from "../base.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

export const encyclopediaRouter = router({
  listPages: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }) =>
      repo(() => encyclopedia.listPages(ctx.db, ctx.user.id, input.workspaceId)),
    ),

  getPage: protectedProcedure
    .input(z.object({ workspaceId: z.string(), slug: z.string() }))
    .query(({ ctx, input }) =>
      repo(() => encyclopedia.getPage(ctx.db, ctx.user.id, input.workspaceId, input.slug)),
    ),

  /** Inserts or merges the page row and, when this call is what puts it into
   * `generating`, schedules the `gemini-flash` run that fills it. */
  requestPage: protectedProcedure
    .input(encyclopediaPageRequestSchema)
    .mutation(({ ctx, input }) => {
      const result = repo(() => encyclopedia.requestPage(ctx.db, ctx.user.id, input));
      publish(ctx, "encyclopedia.page.updated", { page: result.page });
      if (result.shouldGenerate) {
        ctx.runs.enqueueMetadata({
          kind: "encyclopedia",
          userId: ctx.user.id,
          workspaceId: input.workspaceId,
          slug: result.page.slug,
        });
      }
      return result.page;
    }),

  regeneratePage: protectedProcedure
    .input(z.object({ workspaceId: z.string(), slug: z.string() }))
    .mutation(({ ctx, input }) => {
      repo(() => validateEncyclopediaSlug(input.slug));
      const page = repo(() =>
        encyclopedia.regeneratePage(ctx.db, ctx.user.id, input.workspaceId, input.slug),
      );
      publish(ctx, "encyclopedia.page.updated", { page });
      ctx.runs.enqueueMetadata({
        kind: "encyclopedia",
        userId: ctx.user.id,
        workspaceId: input.workspaceId,
        slug: page.slug,
      });
      return page;
    }),

  deletePage: protectedProcedure
    .input(z.object({ workspaceId: z.string(), slug: z.string() }))
    .mutation(({ ctx, input }) => {
      const removed = repo(() =>
        encyclopedia.deletePage(ctx.db, ctx.user.id, input.workspaceId, input.slug),
      );
      if (removed) {
        publish(ctx, "encyclopedia.page.removed", {
          workspaceId: input.workspaceId,
          slug: input.slug,
        });
      }
      return { removed };
    }),
});

export const artifactsRouter = router({
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
