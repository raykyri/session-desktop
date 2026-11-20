// `research.*` procedures on the Trash (the desktop's `trash_research_tree`,
// `restore_research_tree_from_trash`, `list_research_trash`,
// `empty_research_trash`), on `repos/trash.ts` in `@session/db`. Deleting one
// tree, in or out of the Trash, is `research.removeTree` (`trees.ts`).
//
// The Trash is private: these procedures need a signed-in user and are never
// served from the guest catalog.

import { sharing, trash } from "@session/db";
import type { ResearchTree, ResearchTreeSummary } from "@session/shared";
import { z } from "zod";

import { sessionEvent } from "../../../events/bus.js";
import { emitFeedItemRemoved, emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { protectedProcedure } from "../../base.js";
import { publish } from "../../emit.js";
import { repo } from "../../errors.js";

import {
  afterDeparture,
  dispatchFollowups,
  publishSharingChanged,
  treeAudienceIds,
} from "./common.js";

export const trashProcedures = {
  /** Moves a thread, and the children listed under it, to the Trash.
   * Rejected while any of them has an active run. Open views drop each moved
   * thread as they do a deleted one (`research.tree.removed`). The owner's
   * Trash hides the thread from its members too; a member's Trash is scoped
   * to that member and workspace: `workspaceId` names the workspace a member
   * trashes a shared thread from (absent: their default workspace), whose
   * Trash then lists it. */
  trashTree: protectedProcedure
    .input(z.object({ treeId: z.string(), workspaceId: z.string().optional() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() =>
        trash.trashTree(ctx.db, ctx.user.id, input.treeId, { workspaceId: input.workspaceId }),
      );
      const owner = change.tree.role === "owner";
      for (const treeId of change.changedTreeIds) {
        // `trashed: true`: a client keeps the thread's unsent state, since
        // Restore can bring it back; Delete now, Empty Trash and leaving
        // send the event without it.
        const event = sessionEvent("research.tree.removed", {
          treeId,
          removedBy: ctx.user.id,
          trashed: true,
        });
        const recipients = [ctx.user.id, ...(owner ? memberIdsOf(ctx, treeId) : [])];
        ctx.eventBus.emitToUsers(recipients, event);
        if (owner) {
          // The owner's Trash hides the thread from everyone else, readers
          // of a public thread who had it open included.
          ctx.eventBus.emitToOpenReaders(treeId, event, recipients);
          ctx.eventBus.refreshAudience(treeId);
        }
      }
      for (const item of change.removedFeedItems) emitFeedItemRemoved(ctx, item);
      if (change.changedTreeIds.length > 0) {
        publish(ctx, "research.trash.changed", { workspaceId: change.trashWorkspaceId });
      }
      return change.tree;
    }),

  /** Takes a thread, and its children in the Trash, out of the Trash. */
  restoreTreeFromTrash: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trash.restoreTree(ctx.db, ctx.user.id, input.treeId));
      const changed = new Set(change.changedTreeIds);
      for (const tree of [change.tree, ...change.children]) {
        if (!changed.has(tree.id)) continue;
        publish(ctx, "research.tree.restored", { tree });
        if (tree.role !== "owner") continue;
        emitFeedItemUpsertedForNode(ctx, tree.rootNodeId);
        // Members regain access to the thread.
        publishSharingChanged(
          ctx,
          tree.id,
          treeAudienceIds(ctx, tree.id).filter((id) => id !== ctx.user.id),
        );
      }
      if (changed.size > 0) {
        publish(ctx, "research.trash.changed", { workspaceId: change.trashWorkspaceId });
      }
      // Follow-up queues pause while their thread is in the Trash.
      for (const treeId of changed) dispatchFollowups(ctx, treeId);
      return change.tree;
    }),

  /** The workspace's threads in the Trash, most recently trashed first. Its
   * folders in the Trash are in `folders.get`. */
  listTrash: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }): ResearchTreeSummary[] =>
      repo(() => trash.list(ctx.db, ctx.user.id, input.workspaceId)),
    ),

  /** Deletes every thread and folder in the workspace's Trash in one
   * transaction, and returns their ids. */
  emptyTrash: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ ctx, input }): { treeIds: string[]; folderIds: string[] } => {
      const emptied = repo(() => trash.empty(ctx.db, ctx.user.id, input.workspaceId));
      // The emptied threads are hidden; their database rows are deleted in the background.
      ctx.deletions.kick();
      const left = new Set(emptied.leftTreeIds);
      for (const treeId of emptied.treeIds) {
        if (left.has(treeId)) continue;
        publish(ctx, "research.tree.removed", { treeId, removedBy: ctx.user.id });
      }
      // Shared threads the caller left: handled as `sharing.leave` (their queued
      // follow-ups and running questions are stopped; other members receive
      // member change events).
      for (const departure of emptied.departures) afterDeparture(ctx, departure);
      if (emptied.folderIds.length > 0) {
        publish(ctx, "research.folders.changed", { workspaceId: input.workspaceId });
      }
      if (emptied.treeIds.length > 0 || emptied.folderIds.length > 0) {
        publish(ctx, "research.trash.changed", { workspaceId: input.workspaceId });
      }
      return { treeIds: emptied.treeIds, folderIds: emptied.folderIds };
    }),
};

/** The members of a thread the owner just moved to the Trash: its audience
 * is the owner alone now, so they are read from the member rows. */
function memberIdsOf(ctx: { db: Parameters<typeof sharing.memberIds>[0] }, treeId: string) {
  return sharing.memberIds(ctx.db, treeId);
}
