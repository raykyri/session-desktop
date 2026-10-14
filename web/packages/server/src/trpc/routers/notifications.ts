// `notifications`: the signed-in person's inbox (`03-api-and-events.md` §2).
// Web only. Every `notification.requested` the server sends is stored here
// for its recipient (`research/notifications.ts`); the Notifications setting
// only decides whether the client shows it as a toast.

import { notifications } from "@session/db";
import type { InboxNotificationPage } from "@session/shared";
import { z } from "zod";

import type { EventBus } from "../../events/bus.js";
import { sessionEvent } from "../../events/bus.js";
import { protectedProcedure, router } from "../base.js";
import { repo } from "../errors.js";

/** Tells the caller's connections, this tab included, to refetch the inbox
 * and its count. */
function publishRead(ctx: { eventBus: EventBus; user: { id: string } }): void {
  ctx.eventBus.emit(ctx.user.id, sessionEvent("notifications.read", {}));
}

export const notificationsRouter = router({
  /** The caller's notifications, newest first; `cursor` is the previous
   * page's `nextCursor`. */
  list: protectedProcedure
    .input(
      z
        .object({
          cursor: z.string().max(200).nullish(),
          limit: z.number().int().min(1).max(notifications.MAX_NOTIFICATION_PAGE_SIZE).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }): InboxNotificationPage =>
      repo(() =>
        notifications.list(ctx.db, ctx.user.id, {
          cursor: input?.cursor ?? null,
          ...(input?.limit === undefined ? {} : { limit: input.limit }),
        }),
      ),
    ),

  /** How many of the caller's notifications are unread. */
  unreadCount: protectedProcedure.query(({ ctx }): { count: number } => ({
    count: repo(() => notifications.unreadCount(ctx.db, ctx.user.id)),
  })),

  /** Marks one notification read. An unknown id, or one already read,
   * changes nothing. */
  markRead: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }): { changed: boolean } => {
      const changed = repo(() => notifications.markRead(ctx.db, ctx.user.id, input.id));
      if (changed) publishRead(ctx);
      return { changed };
    }),

  /** Marks every unread notification read. */
  markAllRead: protectedProcedure.mutation(({ ctx }): { count: number } => {
    const count = repo(() => notifications.markAllRead(ctx.db, ctx.user.id));
    if (count > 0) publishRead(ctx);
    return { count };
  }),
});
