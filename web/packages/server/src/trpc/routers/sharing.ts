// `sharing`, `invites` and `subscriptions`: who a thread is shared with and
// how (`03-api-and-events.md` §2, `02-domain-model-and-database.md` §5.16).
// Web only; the desktop has one person.
//
// Roles are owner, commenter and viewer (`repos/access.ts`). A thread is
// private (its owner and members) or public (anyone, guests included). The
// owner changes visibility, members and invitations; a member may leave.

import { nodes, queue, sharing, trees } from "@session/db";
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
import { publishQueue } from "../../research/followups.js";
import { notifyInvite } from "../../research/notifications.js";
import { protectedProcedure, router } from "../base.js";
import type { EmitterContext } from "../emit.js";
import { publish, publishToTree } from "../emit.js";
import { repo, required } from "../errors.js";

import { publishSharingChanged, publishTree, treeAudienceIds } from "./research/common.js";

/**
 * After a member leaves or is removed: their queued follow-ups are gone
 * (the queues are announced) and their running questions are stopped, since
 * they can no longer read the thread. They are told the thread is gone, and
 * the rest of the audience that its members changed.
 */
function afterDeparture(ctx: EmitterContext, departure: sharing.Departure): void {
  const { treeId, memberId } = departure;
  for (const headNodeId of departure.changedHeadNodeIds) {
    publishQueue(ctx, ctx.user.id, treeId, headNodeId);
  }
  const ownerId = treeAudienceIds(ctx, treeId)[0];
  for (const nodeId of departure.activeNodeIds) {
    if (ownerId === undefined) break;
    try {
      const node = nodes.setStatus(ctx.db, ownerId, nodeId, "cancelled", {
        error: "Stopped: the person who asked no longer has access to this thread.",
      });
      queue.release(ctx.db, nodeId);
      queue.wakeChildrenOf(ctx.db, nodeId);
      ctx.runs.cancel(nodeId);
      publishToTree(ctx, treeId, "research.node.updated", { node });
    } catch (error) {
      ctx.logger.warn({ nodeId, error }, "could not stop a departed member's run");
    }
  }
  ctx.eventBus.emitToUsers(
    [memberId],
    sessionEvent("research.tree.removed", { treeId, removedBy: ctx.user.id }),
  );
  publishSharingChanged(ctx, treeId, [memberId, ...treeAudienceIds(ctx, treeId)]);
}

const treeInput = z.object({ treeId: z.string() });

export const sharingRouter = router({
  /** Makes a thread public or private. The owner's. A public thread is
   * listed in the All Users feed and the guest catalog. */
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
        publishSharingChanged(ctx, tree.id, treeAudienceIds(ctx, tree.id));
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

  /** Changes a member's role. The owner's. */
  setRole: protectedProcedure
    .input(z.object({ treeId: z.string(), userId: z.string(), role: memberRoleSchema }))
    .mutation(({ ctx, input }): ThreadMember[] => {
      const members = repo(() =>
        sharing.setRole(ctx.db, ctx.user.id, input.treeId, input.userId, input.role),
      );
      publishSharingChanged(ctx, input.treeId, treeAudienceIds(ctx, input.treeId));
      return members;
    }),

  /** Removes a member. The owner's. Their questions, notes and highlights
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
   * `trash` in their own Trash. The web's Shared place.
   */
  listShared: protectedProcedure
    .input(z.object({ place: z.enum(["shared", "archive", "trash"]).optional() }).optional())
    .query(({ ctx, input }): ResearchTreeSummary[] =>
      repo(() => trees.sharedSummaries(ctx.db, ctx.user.id, input?.place ?? "shared")),
    ),
});

/** The link that accepts an invitation; the client route reads `token`. */
function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

export const invitesRouter = router({
  /**
   * Invites someone, by GitHub login (accepted once, by that account) or by
   * link (accepted by anyone holding it). The owner's. The token is in the
   * answer only: the server stores its hash. Invitations expire after
   * fourteen days.
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
        notifyInvite(ctx, created.inviteeId, input.treeId, ctx.user.login);
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
   * to the caller's login. Answers with the thread as the caller now sees
   * it. */
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
      }
      return tree;
    }),

  /** Revokes a pending invitation. The owner's. */
  revoke: protectedProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(({ ctx, input }): ThreadInvite =>
      repo(() => sharing.revokeInvite(ctx.db, ctx.user.id, input.inviteId)),
    ),
});

export const subscriptionsRouter = router({
  /** Follow: notifications for new questions and notes in the thread. Anyone
   * signed in who may read it. Answers with the thread as the caller sees
   * it (`followed`), which is also published to their own connections. */
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
