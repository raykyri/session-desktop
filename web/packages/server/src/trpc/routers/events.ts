// `events`
// (`03-api-and-events.md` §2).

import { randomUUID } from "node:crypto";

import { auth } from "@session/db";
import type { SessionEvent, ThreadViewer } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { MAX_OPEN_TREES } from "../../events/bus.js";
import { requireTreeRole, treeRole } from "../../research/access.js";
import { budgetedProcedure, protectedProcedure, router } from "../base.js";

export const eventsRouter = router({
  /**
   * The event stream, served as SSE by the fetch adapter. `connectionId` allows
   * the client to identify its connection in `setInterest`; when omitted, the
   * server generates an identifier and emits it in the initial event.
   *
   * The stream is tied to the active session: signing out, session deletion,
   * or session expiration (verified every `SESSION_STREAM_CHECK_MS`, `auth/session.ts`)
   * terminates the stream with an `UNAUTHORIZED` error.
   */
  subscribe: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1).max(64).optional() }).optional())
    .subscription(async function* ({ ctx, input, signal }) {
      const connectionId = input?.connectionId ?? randomUUID();
      const sessionId = ctx.sessionToken === null ? null : auth.hashSessionToken(ctx.sessionToken);
      const subscription = ctx.eventBus.subscribe(ctx.user.id, connectionId, signal, {
        sessionId,
      });
      try {
        yield {
          type: "connection.ready",
          payload: { connectionId },
          timestamp: Date.now(),
        } satisfies SessionEvent;
        for await (const event of subscription.events) {
          yield event;
        }
        if (subscription.sessionEnded()) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "the session has ended" });
        }
      } finally {
        subscription.close();
      }
    }),

  /**
   * Updates subscription interest for active node deltas and open threads.
   * Non-member readers of public threads receive events for open threads,
   * which are also used for presence tracking (`research.presence.changed`).
   * Periodic updates refresh presence before expiration (`PRESENCE_TTL_MS`).
   * Unauthorized thread IDs are filtered out. Renewals are rate-limited under
   * `RATE_LIMITS.interest`.
   */
  setInterest: budgetedProcedure("interest", "too many interest updates; try again in a moment")
    .input(
      z.object({
        connectionId: z.string(),
        nodeIds: z.array(z.string()).max(200),
        treeIds: z.array(z.string()).max(MAX_OPEN_TREES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ({
      // Returns false if the connection is no longer active; the client
      // re-registers interest upon reconnecting.
      applied: ctx.eventBus.setInterest(
        ctx.user.id,
        input.connectionId,
        input.nodeIds,
        input.treeIds?.filter((treeId) => treeRole(ctx.db, ctx.user.id, treeId) !== null),
      ),
    })),

  /** Returns active viewers currently viewing the specified thread. */
  presence: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .query(({ ctx, input }): ThreadViewer[] => {
      requireTreeRole(ctx, input.treeId, "viewer");
      return ctx.eventBus.viewers(input.treeId);
    }),
});
