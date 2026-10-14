// `events`
// (`03-api-and-events.md` §2).

import { randomUUID } from "node:crypto";

import type { SessionEvent, ThreadViewer } from "@session/shared";
import { z } from "zod";

import { MAX_OPEN_TREES } from "../../events/bus.js";
import { requireTreeRole, treeRole } from "../../research/access.js";
import { protectedProcedure, router } from "../base.js";

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

  /**
   * Which active nodes this connection wants turn deltas for and, with
   * `treeIds`, which threads it has open. Open threads are what a reader of
   * a public thread who is not a member receives that thread's events
   * through, and what presence (`research.presence.changed`) reports;
   * sending the same `treeIds` again renews presence, which lapses after
   * `PRESENCE_TTL_MS` without a renewal. Ids of threads the caller may not
   * read are dropped.
   */
  setInterest: protectedProcedure
    .input(
      z.object({
        connectionId: z.string(),
        nodeIds: z.array(z.string()).max(200),
        treeIds: z.array(z.string()).max(MAX_OPEN_TREES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ({
      // False when the connection has already gone; the client's next
      // subscribe publishes its interest again.
      applied: ctx.eventBus.setInterest(
        ctx.user.id,
        input.connectionId,
        input.nodeIds,
        input.treeIds?.filter((treeId) => treeRole(ctx.db, ctx.user.id, treeId) !== null),
      ),
    })),

  /** Who has the thread open now (`research.presence.changed` reports
   * changes). */
  presence: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .query(({ ctx, input }): ThreadViewer[] => {
      requireTreeRole(ctx, input.treeId, "viewer");
      return ctx.eventBus.viewers(input.treeId);
    }),
});
