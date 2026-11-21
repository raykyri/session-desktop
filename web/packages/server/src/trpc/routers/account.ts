// `auth`, `settings`, `usage`, and `admin`
// (`03-api-and-events.md` §2, `06-auth-and-users.md` §6, §8).

import { auth, preferences, usage } from "@session/db";
import type { User, UserSettings } from "@session/shared";
import { clampResearchLaunchInstruction, userSettingsSchema } from "@session/shared";
import { z } from "zod";

import { endSession } from "../../auth/session.js";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../base.js";
import { repo } from "../errors.js";

import { usageProcedures } from "./keys.js";
import { adminModelsRouter } from "./models.js";

export interface StoredSettings extends UserSettings {
  researchLaunchInstruction: string | null;
  defaultModel: string;
}

function readSettings(
  ctx: { db: Parameters<typeof preferences.ensure>[0] },
  userId: string,
): StoredSettings {
  const stored = repo(() => preferences.ensure(ctx.db, userId));
  return {
    ...stored.settings,
    researchLaunchInstruction: stored.researchLaunchInstruction,
    defaultModel: stored.settings.defaultModel,
  };
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }): User | null => ctx.user),
  logout: publicProcedure.mutation(({ ctx }) => {
    // Deletes the current session record, invalidating the session token.
    // Other sessions for the account remain active.
    if (ctx.sessionToken !== null) {
      endSession(ctx, ctx.sessionToken);
    }
    return { ok: true };
  }),
});

export const settingsRouter = router({
  get: protectedProcedure.query(({ ctx }) => readSettings(ctx, ctx.user.id)),
  update: protectedProcedure
    .input(
      z.object({
        settings: userSettingsSchema.partial().optional(),
        researchLaunchInstruction: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const patch: Parameters<typeof preferences.update>[2] = {};
      if (input.settings !== undefined) {
        patch.settings = input.settings;
      }
      if (input.researchLaunchInstruction !== undefined) {
        // The 4 KiB limit is defined in `shared` so the composer and the server
        // maintain identical length bounds (`06-auth-and-users.md` §6).
        patch.researchLaunchInstruction =
          input.researchLaunchInstruction === null
            ? null
            : clampResearchLaunchInstruction(input.researchLaunchInstruction);
      }
      repo(() => preferences.update(ctx.db, ctx.user.id, patch));
      return readSettings(ctx, ctx.user.id);
    }),
});

export const usageRouter = router({
  ...usageProcedures,
  summary: protectedProcedure.input(z.undefined()).query(({ ctx }) =>
    repo(() =>
      usage.summary(ctx.db, ctx.user.id, {
        dailyTokens: ctx.config.limits.dailyTokens,
        dailyRuns: ctx.config.limits.dailyRuns,
      }),
    ),
  ),
});

export const adminRouter = router({
  /** The Site Admin settings: default model and default effort (`03` K15). */
  models: adminModelsRouter,
  /** Generates administrative invite codes. Leaves createdBy null so admin codes do not decrement personal invite allowances. */
  createInvites: adminProcedure
    .input(z.object({ count: z.number().int().min(1).max(100) }))
    .mutation(({ ctx, input }) => {
      ctx.logger.info({ adminId: ctx.user.id, count: input.count }, "created invite codes");
      return { codes: repo(() => auth.createInvites(ctx.db, null, input.count)) };
    }),
});
