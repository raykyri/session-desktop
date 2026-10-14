// `research.*` procedures on the Trash (the desktop's `trash_research_tree`,
// `restore_research_tree_from_trash`, `list_research_trash`,
// `empty_research_trash`), on `repos/trash.ts` in `@session/db`. Deleting one
// tree, in or out of the Trash, is `research.removeTree` (`trees.ts`).
//
// The Trash is private: these procedures need a signed-in user and are never
// served from the guest catalog.

import { trash } from "@session/db";
import type { ResearchTree, ResearchTreeSummary } from "@session/shared";
import { z } from "zod";

import { emitFeedItemRemoved, emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { protectedProcedure } from "../../base.js";
import { publish } from "../../emit.js";
import { repo } from "../../errors.js";

import { dispatchFollowups } from "./common.js";

export const trashProcedures = {
  /** Moves a thread, and the children listed under it, to the Trash.
   * Refused while any of them has an active run. Open views drop each moved
   * thread as they do a deleted one (`research.tree.removed`). */
  trashTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trash.trashTree(ctx.db, ctx.user.id, input.treeId));
      for (const treeId of change.changedTreeIds) {
        publish(ctx, "research.tree.removed", { treeId });
      }
      for (const item of change.removedFeedItems) emitFeedItemRemoved(ctx.eventBus, item);
      if (change.changedTreeIds.length > 0) {
        publish(ctx, "research.trash.changed", { workspaceId: change.tree.workspaceId });
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
        emitFeedItemUpsertedForNode(ctx, tree.rootNodeId);
      }
      if (changed.size > 0) {
        publish(ctx, "research.trash.changed", { workspaceId: change.tree.workspaceId });
      }
      // Follow-up queues wait while their thread is in the Trash.
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
   * transaction, and answers with their ids. */
  emptyTrash: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ ctx, input }): { treeIds: string[]; folderIds: string[] } => {
      const emptied = repo(() => trash.empty(ctx.db, ctx.user.id, input.workspaceId));
      for (const treeId of emptied.treeIds) {
        publish(ctx, "research.tree.removed", { treeId });
      }
      if (emptied.folderIds.length > 0) {
        publish(ctx, "research.folders.changed", { workspaceId: input.workspaceId });
      }
      if (emptied.treeIds.length > 0 || emptied.folderIds.length > 0) {
        publish(ctx, "research.trash.changed", { workspaceId: input.workspaceId });
      }
      return emptied;
    }),
};
