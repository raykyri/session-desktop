// Drafts (`03-api-and-events.md` §2). Two routers, both per person:
//
// - `interfaceDrafts.get/set`: opaque client state that has to survive a
//   reload on another device (the desktop's `interface_draft_get/set`);
// - `drafts.list/save/remove/reorder`: the saved list of unsent questions in
//   the Drafts place (the desktop's `list_research_drafts`,
//   `save_research_draft`, `delete_research_draft`,
//   `reorder_research_drafts`). Every change emits
//   `research.drafts.changed { workspaceId }` to the person's own
//   connections only.

import { drafts as interfaceDraftsRepo, researchDrafts } from "@session/db";
import type { ResearchDraft } from "@session/shared";
import { z } from "zod";

import { resolveImageAttachments } from "../../research/images.js";
import { protectedProcedure, router } from "../base.js";
import { publish } from "../emit.js";
import { repo } from "../errors.js";

export const interfaceDraftsRouter = router({
  get: protectedProcedure.input(z.object({ key: z.string().min(1) })).query(({ ctx, input }) => ({
    key: input.key,
    value: repo(() => interfaceDraftsRepo.get(ctx.db, ctx.user.id, input.key)),
  })),
  set: protectedProcedure
    .input(z.object({ key: z.string().min(1), value: z.string() }))
    .mutation(({ ctx, input }) => {
      if (input.value === "") {
        repo(() => interfaceDraftsRepo.remove(ctx.db, ctx.user.id, input.key));
        return { key: input.key, value: null };
      }
      repo(() => interfaceDraftsRepo.set(ctx.db, ctx.user.id, input.key, input.value));
      return { key: input.key, value: input.value };
    }),
});

export const draftsRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }): ResearchDraft[] =>
      repo(() => researchDrafts.list(ctx.db, ctx.user.id, input.workspaceId)),
    ),

  /** Without an id, creates a draft at the top of the list; with one,
   * replaces that draft's prompt. `images` (ids from `POST /api/images`)
   * replaces the draft's images; omitted, they are kept. */
  save: protectedProcedure
    .input(
      z.object({
        id: z.string().nullish(),
        workspaceId: z.string(),
        prompt: z.string(),
        images: z.array(z.string()).nullish(),
      }),
    )
    .mutation(({ ctx, input }): ResearchDraft => {
      const images =
        input.images === null || input.images === undefined
          ? null
          : resolveImageAttachments(ctx.db, ctx.user.id, input.images);
      const draft = repo(() =>
        researchDrafts.save(ctx.db, ctx.user.id, {
          id: input.id,
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          images,
        }),
      );
      publish(ctx, "research.drafts.changed", { workspaceId: draft.workspaceId });
      return draft;
    }),

  remove: protectedProcedure.input(z.object({ draftId: z.string() })).mutation(({ ctx, input }) => {
    const { workspaceId } = repo(() => researchDrafts.remove(ctx.db, ctx.user.id, input.draftId));
    publish(ctx, "research.drafts.changed", { workspaceId });
    return { ok: true };
  }),

  /** `draftIds` must name exactly the workspace's drafts. */
  reorder: protectedProcedure
    .input(z.object({ workspaceId: z.string(), draftIds: z.array(z.string()) }))
    .mutation(({ ctx, input }): ResearchDraft[] => {
      const result = repo(() =>
        researchDrafts.reorder(ctx.db, ctx.user.id, input.workspaceId, input.draftIds),
      );
      if (result.changed) {
        publish(ctx, "research.drafts.changed", { workspaceId: input.workspaceId });
      }
      return result.drafts;
    }),
});
