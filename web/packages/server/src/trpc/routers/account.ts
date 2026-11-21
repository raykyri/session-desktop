// `auth`, `settings`, `usage`, and `admin`
// (`03-api-and-events.md` §2, `06-auth-and-users.md` §6, §8).

import { accountInvites, auth, preferences, usage, users } from "@session/db";
import type { Me, User, UserSettings } from "@session/shared";
import { clampResearchLaunchInstruction, userSettingsSchema } from "@session/shared";
import { z } from "zod";

import { seal } from "../../auth/secretBox.js";
import { endSession } from "../../auth/session.js";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../base.js";
import { repo, required } from "../errors.js";

import { checkInviteProcedure, meOf } from "./membership.js";

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
  /** The account, with the invite its profile step will redeem. */
  me: publicProcedure.query(({ ctx }): Me | null => meOf(ctx)),
  checkInvite: checkInviteProcedure,
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
  summary: protectedProcedure.input(z.undefined()).query(({ ctx }) =>
    repo(() =>
      usage.summary(ctx.db, ctx.user.id, {
        dailyTokens: ctx.config.limits.dailyTokens,
        dailyRuns: ctx.config.limits.dailyRuns,
      }),
    ),
  ),
});

/** One UTC day of usage, restated here rather than inferred from the
 * repository: the router's type is what the client compiles against, and it
 * must not name a type inside `@session/db` (ADR-1). */
export interface DailyUsageTotals {
  day: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costEstimateMicros: number;
  runs: number;
}

export interface DailyLimits {
  dailyTokens: number | null;
  dailyRuns: number | null;
}

export interface AdminUser extends User {
  usage: DailyUsageTotals;
  limits: DailyLimits;
}

export const adminRouter = router({
  listUsers: adminProcedure.query(({ ctx }): AdminUser[] =>
    repo(() =>
      users.listUsers(ctx.db).map((user) => ({
        ...user,
        usage: usage.dailyTotals(ctx.db, user.id),
        limits: usage.effectiveLimits(ctx.db, user.id, {
          dailyTokens: ctx.config.limits.dailyTokens,
          dailyRuns: ctx.config.limits.dailyRuns,
        }),
      })),
    ),
  ),
  setLimits: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        dailyTokens: z.number().int().min(0).nullable().optional(),
        dailyRuns: z.number().int().min(0).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }): DailyLimits => {
      required(
        repo(() => users.findById(ctx.db, input.userId)),
        `account ${input.userId} was not found`,
      );
      const patch: { dailyTokens?: number | null; dailyRuns?: number | null } = {};
      if (input.dailyTokens !== undefined) {
        patch.dailyTokens = input.dailyTokens;
      }
      if (input.dailyRuns !== undefined) {
        patch.dailyRuns = input.dailyRuns;
      }
      // Runs held for the old limits are not released here: the run queue
      // that held them was removed with the research model, and the run
      // dispatcher of plan `03` E2 (M5a) checks limits when it claims a run.
      return repo(() => auth.setUserLimits(ctx.db, input.userId, patch));
    }),
  /** Account invites made by a site admin, who is exempt from the open-links
   * limit (04 I2); they are the admin's own links and appear on their
   * Invites page. */
  createInvites: adminProcedure
    .input(z.object({ count: z.number().int().min(1).max(100) }))
    .mutation(({ ctx, input }) => {
      ctx.logger.info({ adminId: ctx.user.id, count: input.count }, "created invite codes");
      const codes: string[] = [];
      for (let index = 0; index < input.count; index += 1) {
        const made = accountInvites.create(ctx.db, {
          createdBy: ctx.user.id,
          exempt: true,
          encrypt: (code) => seal(ctx.config.secretKey, code, `account-invite:${ctx.user.id}`),
        });
        if (made.ok) codes.push(made.code);
      }
      return { codes };
    }),
});
