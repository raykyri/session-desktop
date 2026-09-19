// `workspaces` and `folders` (`03-api-and-events.md` §2).

import { folders, workspaces } from "@session/db";
import type { Workspace } from "@session/shared";
import { emptyResearchFolderState, researchFolderStateSchema } from "@session/shared";
import { z } from "zod";

import { protectedProcedure, publicProcedure, router } from "../base.js";
import { catalogUserId } from "../catalog.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

export interface WorkspaceWithCount extends Workspace {
  treeCount: number;
}

function listWithCounts(
  db: Parameters<typeof workspaces.list>[0],
  userId: string,
): WorkspaceWithCount[] {
  const counts = workspaces.treeCounts(db, userId);
  return workspaces
    .list(db, userId)
    .map((workspace) => ({ ...workspace, treeCount: counts.get(workspace.id) ?? 0 }));
}

export const workspacesRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    const userId = catalogUserId(ctx);
    if (userId === null) return [];
    return repo(() => listWithCounts(ctx.db, userId));
  }),

  ensureDefault: protectedProcedure.mutation(({ ctx }) => {
    const before = repo(() => workspaces.list(ctx.db, ctx.user.id)).length;
    const workspace = repo(() => workspaces.ensureDefault(ctx.db, ctx.user.id));
    if (before === 0) {
      publish(ctx, "workspace.created", { workspace });
    }
    return workspace;
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(120) }))
    .mutation(({ ctx, input }) => {
      const workspace = repo(() => workspaces.create(ctx.db, ctx.user.id, input.name));
      publish(ctx, "workspace.created", { workspace });
      return workspace;
    }),

  rename: protectedProcedure
    .input(z.object({ workspaceId: z.string(), name: z.string().min(1).max(120) }))
    .mutation(({ ctx, input }) => {
      const workspace = repo(() =>
        workspaces.rename(ctx.db, ctx.user.id, input.workspaceId, input.name),
      );
      publish(ctx, "workspace.updated", { workspace });
      return workspace;
    }),

  remove: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ ctx, input }) => {
      required(
        repo(() => workspaces.get(ctx.db, ctx.user.id, input.workspaceId)),
        `research workspace ${input.workspaceId} was not found`,
      );
      const result = repo(() => workspaces.remove(ctx.db, ctx.user.id, input.workspaceId));
      for (const treeId of result.removedTreeIds) {
        publish(ctx, "research.tree.removed", { treeId });
      }
      publish(ctx, "workspace.removed", { workspaceId: input.workspaceId });
      return result;
    }),

  setDefault: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ ctx, input }) => {
      const workspace = repo(() => workspaces.setDefault(ctx.db, ctx.user.id, input.workspaceId));
      publish(ctx, "workspace.updated", { workspace });
      return workspace;
    }),

  reorder: protectedProcedure
    .input(z.object({ workspaceIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      const ordered = repo(() => workspaces.reorder(ctx.db, ctx.user.id, input.workspaceIds));
      for (const workspace of ordered) {
        publish(ctx, "workspace.updated", { workspace });
      }
      return ordered;
    }),
});

export const foldersRouter = router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ ctx, input }) => {
    const userId = catalogUserId(ctx);
    if (userId === null) return emptyResearchFolderState();
    return repo(() => folders.getState(ctx.db, userId, input.workspaceId));
  }),

  set: protectedProcedure
    .input(z.object({ workspaceId: z.string(), state: researchFolderStateSchema }))
    .mutation(({ ctx, input }) => {
      const state = repo(() =>
        folders.setState(ctx.db, ctx.user.id, input.workspaceId, input.state),
      );
      publish(ctx, "folders.updated", { workspaceId: input.workspaceId, state });
      return state;
    }),
});
