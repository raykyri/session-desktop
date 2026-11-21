// `models.list` and `admin.models.*` (`03-agents-and-research.md` K11, K15;
// decision P11; ADR-23). Online-only (ADR-19).

import { z } from "zod";

import type { ModelListing } from "../../models/siteDefaults.js";
import { modelListing, setDefaultEffort, setDefaultModel } from "../../models/siteDefaults.js";
import { adminProcedure, protectedProcedure, router } from "../base.js";

export const modelsRouter = router({
  /** Every registry entry with its payers and efforts, the default model and
   * the default effort: where members' composers start. */
  list: protectedProcedure.query(({ ctx }): ModelListing => modelListing(ctx.db, ctx.models)),
});

export const adminModelsRouter = router({
  list: adminProcedure.query(({ ctx }): ModelListing => modelListing(ctx.db, ctx.models)),
  /** Returns the new default model; the default effort is left as it is. */
  setDefault: adminProcedure
    .input(z.object({ model: z.string().max(200) }))
    .mutation(({ ctx, input }) => ({
      defaultModel: setDefaultModel(
        {
          db: ctx.db,
          registry: ctx.models,
          logger: ctx.logger,
          adminId: ctx.user.id,
          now: ctx.now(),
        },
        input.model,
      ),
    })),
  /** Returns the new default effort: low, medium, high or max. */
  setDefaultEffort: adminProcedure
    .input(z.object({ effort: z.string().max(20) }))
    .mutation(({ ctx, input }) => ({
      defaultEffort: setDefaultEffort(
        { db: ctx.db, logger: ctx.logger, adminId: ctx.user.id, now: ctx.now() },
        input.effort,
      ),
    })),
});
