// `sharing`, `invites` and `subscriptions`: who a thread is shared with and
// how (`03-api-and-events.md` §2, `02-domain-model-and-database.md` §5.16).
// Web only; the desktop is single-user.
//
// Roles are owner, commenter and viewer (`repos/access.ts`). A thread is
// private (its owner and members) or public (anyone, guests included). The
// owner changes visibility, members and invitations; a member may leave.

import { sharing, trees } from "@session/db";
import type {
  CreatedInvite,
  ReceivedInvite,
  ResearchTree,
  ResearchTreeSummary,
  ThreadInvite,
  ThreadMember,
} from "@session/shared";
import { memberRoleSchema, researchTreeVisibilitySchema } from "@session/shared";
import { z } from "zod";

import { sessionEvent } from "../../events/bus.js";
import { emitFeedVisibilityChanged } from "../../events/feed.js";
import { notifyInvite } from "../../research/notifications.js";
import { protectedProcedure, router } from "../base.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

import {
  afterDeparture,
  afterQueuedFollowupsDropped,
  publishSharingChanged,
  publishTree,
  treeAudienceIds,
} from "./research/common.js";

const treeInput = z.object({ treeId: z.string() });

export const sharingRouter = router({
  /** Makes a thread public or private. Restricted to the owner. A public
   * thread is listed in the All Users feed and the guest catalog. */
  setVisibility: protectedProcedure
    .input(z.object({ treeId: z.string(), visibility: researchTreeVisibilitySchema }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() =>
        sharing.setVisibility(ctx.db, ctx.user.id, input.treeId, input.visibility),
      );
      const tree = required(
        repo(() => trees.get(ctx.db, ctx.user.id, input.treeId)),
        `research tree ${input.treeId} was not found`,
      );
      if (change.changed) {
        publishTree(ctx, "research.tree.updated", tree);
        const audience = treeAudienceIds(ctx, tree.id);
        publishSharingChanged(ctx, tree.id, audience);
        if (input.visibility === "private") {
          // Non-member readers who had the thread open lose access: they
          // receive an update event, and their open-thread declarations
          // (events, presence) are dropped.
          ctx.eventBus.emitToOpenReaders(
            tree.id,
            sessionEvent("research.sharing.changed", { treeId: tree.id }),
            audience,
          );
          ctx.eventBus.refreshAudience(tree.id);
        }
        if (change.after.archivedAt === null && change.after.trashedAt === null) {
          emitFeedVisibilityChanged(ctx, change.after.rootNodeId, input.visibility);
        }
      }
      return tree;
    }),

  /** The owner first, then the members in the order they joined. Anyone
   * who may read the thread. */
  listMembers: protectedProcedure
    .input(treeInput)
    .query(({ ctx, input }): ThreadMember[] =>
      repo(() => sharing.listMembers(ctx.db, ctx.user.id, input.treeId)),
    ),

  /** Changes a member's role. Restricted to the owner. A member made a viewer can no
   * longer ask: their queued follow-ups are dropped. */
  setRole: protectedProcedure
    .input(z.object({ treeId: z.string(), userId: z.string(), role: memberRoleSchema }))
    .mutation(({ ctx, input }): ThreadMember[] => {
      const change = repo(() =>
        sharing.setRole(ctx.db, ctx.user.id, input.treeId, input.userId, input.role),
      );
      afterQueuedFollowupsDropped(ctx, input.treeId, change.dropped);
      publishSharingChanged(ctx, input.treeId, treeAudienceIds(ctx, input.treeId));
      return change.members;
    }),

  /** Removes a member. Restricted to the owner. Their questions, notes and highlights
   * stay in the thread; their queued follow-ups are dropped and their
   * running questions stopped. */
  removeMember: protectedProcedure
    .input(z.object({ treeId: z.string(), userId: z.string() }))
    .mutation(({ ctx, input }) => {
      const departure = repo(() =>
        sharing.removeMember(ctx.db, ctx.user.id, input.treeId, input.userId),
      );
      afterDeparture(ctx, departure);
      return { ok: true };
    }),

  /** The caller leaves a thread shared with them. */
  leave: protectedProcedure.input(treeInput).mutation(({ ctx, input }) => {
    const departure = repo(() => sharing.leave(ctx.db, ctx.user.id, input.treeId));
    afterDeparture(ctx, departure);
    return { ok: true };
  }),

  /**
   * The threads shared with the caller (they are a member, not the owner):
   * `shared` (the default) outside their Archive and Trash, most recently
   * updated first; `archive` in their Archive or archived by the owner;
   * `trash` in their own Trash. The web's Shared place. With `workspaceId`,
   * `trash` lists only the threads moved to the Trash from that workspace
   * (`research.trashTree`); `shared` and `archive` ignore it.
   */
  listShared: protectedProcedure
    .input(
      z
        .object({
          place: z.enum(["shared", "archive", "trash"]).optional(),
          workspaceId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }): ResearchTreeSummary[] =>
      repo(() =>
        trees.sharedSummaries(ctx.db, ctx.user.id, input?.place ?? "shared", {
          workspaceId: input?.workspaceId ?? null,
        }),
      ),
    ),
});

/** The link that accepts an invitation. The token is the URL fragment, which
 * browsers do not send in requests or `Referer` headers, so it reaches no
 * server or proxy log; the client route (`routes/invite.tsx`) reads it,
 * removes it from the address bar and posts it to `invites.accept`. */
function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite#${encodeURIComponent(token)}`;
}

export const invitesRouter = router({
  /**
   * Invites someone, by GitHub login (accepted once, by that account) or by
   * link (accepted by anyone holding it). The owner's. The token is in the
   * answer only: the server stores its hash. Invitations expire after
   * fourteen days. Inviting a login that already has a pending invitation
   * renews it (one per account and thread; the earlier link stops working);
   * inviting an existing member is rejected (`@login already has access to this
   * thread.`), as is exceeding 100 login invitations per day.
   */
  create: protectedProcedure
    .input(
      z.object({
        treeId: z.string(),
        role: memberRoleSchema,
        githubLogin: z.string().trim().min(1).max(39).optional(),
      }),
    )
    .mutation(({ ctx, input }): CreatedInvite => {
      const created = repo(() =>
        sharing.createInvite(ctx.db, ctx.user.id, {
          treeId: input.treeId,
          role: input.role,
          githubLogin: input.githubLogin ?? null,
        }),
      );
      if (created.inviteeId !== null) {
        // A renewed invitation (the same login invited again) updates the
        // invitee's list without another notification.
        if (!created.renewed) {
          notifyInvite(ctx, created.inviteeId, input.treeId, ctx.user.login);
        }
        ctx.eventBus.emit(
          created.inviteeId,
          sessionEvent("research.invites.changed", { treeId: input.treeId }),
        );
      }
      return {
        invite: created.invite,
        token: created.token,
        url: inviteUrl(ctx.config.publicOrigin, created.token),
      };
    }),

  /** A thread's pending invitations. The owner's. */
  list: protectedProcedure
    .input(treeInput)
    .query(({ ctx, input }): ThreadInvite[] =>
      repo(() => sharing.listInvites(ctx.db, ctx.user.id, input.treeId)),
    ),

  /** The pending invitations addressed to the caller's GitHub login. */
  received: protectedProcedure.query(({ ctx }): ReceivedInvite[] =>
    repo(() => sharing.receivedInvites(ctx.db, ctx.user.login)),
  ),

  /** Accepts an invitation by its link's token, or by id for one addressed
   * to the caller's login. Returns the thread record for the caller. */
  accept: protectedProcedure
    .input(z.union([z.object({ token: z.string().min(1) }), z.object({ inviteId: z.string() })]))
    .mutation(({ ctx, input }): ResearchTree => {
      const accepted = repo(() =>
        sharing.acceptInvite(ctx.db, { id: ctx.user.id, login: ctx.user.login }, input),
      );
      const tree = required(
        repo(() => trees.get(ctx.db, ctx.user.id, accepted.treeId)),
        `research tree ${accepted.treeId} was not found`,
      );
      if (accepted.joined) {
        publishSharingChanged(ctx, tree.id, treeAudienceIds(ctx, tree.id));
      } else if (accepted.restored) {
        // Out of the caller's own Archive or Trash: their lists change.
        publishSharingChanged(ctx, tree.id, [ctx.user.id]);
      }
      return tree;
    }),

  /** Revokes a pending invitation. Restricted to the owner. */
  revoke: protectedProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(({ ctx, input }): ThreadInvite =>
      repo(() => sharing.revokeInvite(ctx.db, ctx.user.id, input.inviteId)),
    ),
});

export const subscriptionsRouter = router({
  /** Follow: notifications for new questions and notes in the thread. Available
   * to any signed-in user with read access. Returns the thread record for the
   * caller (`followed`), which is also published to their connections. */
  set: protectedProcedure
    .input(z.object({ treeId: z.string(), value: z.boolean() }))
    .mutation(({ ctx, input }): ResearchTree => {
      repo(() => sharing.setFollowing(ctx.db, ctx.user.id, input.treeId, input.value));
      const tree = required(
        repo(() => trees.get(ctx.db, ctx.user.id, input.treeId)),
        `research tree ${input.treeId} was not found`,
      );
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),
});
