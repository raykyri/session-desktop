// `models.list` and `admin.models.*` (`03-agents-and-research.md` K11, K15;
// decision P11; ADR-23). Online-only (ADR-19).

import { z } from "zod";

import type { ModelListing } from "../../models/siteDefaults.js";
import { modelListing, setDefaultEffort, setDefaultModel } from "../../models/siteDefaults.js";
import { adminProcedure, limit, protectedProcedure, router } from "../base.js";

/** 60 calls a minute per site admin (`04` Z1), shared with `admin.invites.*`. */
export const adminModelsProcedure = adminProcedure.use(
  limit("adminModels", "user", (wait) => `Too many changes. Try again in ${wait}.`),
);

export const modelsRouter = router({
  /** Every registry entry with its payers and efforts, the default model and
   * the default effort: where members' composers start. */
  list: protectedProcedure.query(({ ctx }): ModelListing => modelListing(ctx.db, ctx.models)),
});

export const adminModelsRouter = router({
  list: adminModelsProcedure.query(({ ctx }): ModelListing => modelListing(ctx.db, ctx.models)),
  /** Returns the new default model; the default effort is left as it is. */
  setDefault: adminModelsProcedure
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
  setDefaultEffort: adminModelsProcedure
    .input(z.object({ effort: z.string().max(20) }))
    .mutation(({ ctx, input }) => ({
      defaultEffort: setDefaultEffort(
        { db: ctx.db, logger: ctx.logger, adminId: ctx.user.id, now: ctx.now() },
        input.effort,
      ),
    })),
});
