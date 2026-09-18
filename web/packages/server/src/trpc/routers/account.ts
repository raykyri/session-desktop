// `auth`, `settings`, `drafts`, `usage`, and `admin`
// (`03-api-and-events.md` §2, `06-auth-and-users.md` §6, §8).

import { auth, drafts as draftsRepo, preferences, usage, users, workspaces } from "@session/db";
import type { User, UserSettings } from "@session/shared";
import { clampResearchLaunchInstruction, userSettingsSchema } from "@session/shared";
import { z } from "zod";

import { adminProcedure, protectedProcedure, publicProcedure, router } from "../base.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

export interface StoredSettings extends UserSettings {
  researchLaunchInstruction: string | null;
  defaultWorkspaceId: string | null;
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
    defaultWorkspaceId: stored.defaultWorkspaceId,
    defaultModel: stored.settings.defaultModel,
  };
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }): User | null => ctx.user),
  logout: publicProcedure.mutation(({ ctx }) => {
    // The cookie is cleared by the Hono layer, which owns `Set-Cookie`; here
    // the row goes so a stolen cookie stops working immediately. Only this
    // session's row: signing out of one browser is not signing out of the
    // account's others (`06-auth-and-users.md` §2).
    if (ctx.sessionToken !== null) {
      auth.deleteSession(ctx.db, ctx.sessionToken);
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
        defaultWorkspaceId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const patch: Parameters<typeof preferences.update>[2] = {};
      if (input.settings !== undefined) {
        patch.settings = input.settings;
      }
      if (input.researchLaunchInstruction !== undefined) {
        // The 4 KiB cap belongs to `shared` so the composer and the server
        // agree on where the text is cut (`06-auth-and-users.md` §6).
        patch.researchLaunchInstruction =
          input.researchLaunchInstruction === null
            ? null
            : clampResearchLaunchInstruction(input.researchLaunchInstruction);
      }
      if (input.defaultWorkspaceId !== undefined) {
        // `workspaces.setDefault` checks ownership; this path has to as well,
        // or a preference could point at another account's workspace.
        if (input.defaultWorkspaceId !== null) {
          required(
            repo(() => workspaces.get(ctx.db, ctx.user.id, input.defaultWorkspaceId ?? "")),
            `research workspace ${input.defaultWorkspaceId} was not found`,
          );
        }
        patch.defaultWorkspaceId = input.defaultWorkspaceId;
      }
      repo(() => preferences.update(ctx.db, ctx.user.id, patch));
      const settings = readSettings(ctx, ctx.user.id);
      publish(ctx, "settings.updated", { settings });
      return settings;
    }),
});

export const draftsRouter = router({
  get: protectedProcedure.input(z.object({ key: z.string().min(1) })).query(({ ctx, input }) => ({
    key: input.key,
    value: repo(() => draftsRepo.get(ctx.db, ctx.user.id, input.key)),
  })),
  set: protectedProcedure
    .input(z.object({ key: z.string().min(1), value: z.string() }))
    .mutation(({ ctx, input }) => {
      if (input.value === "") {
        repo(() => draftsRepo.remove(ctx.db, ctx.user.id, input.key));
        return { key: input.key, value: null };
      }
      repo(() => draftsRepo.set(ctx.db, ctx.user.id, input.key, input.value));
      return { key: input.key, value: input.value };
    }),
});

export const usageRouter = router({
  summary: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(31).optional() }).optional())
    .query(({ ctx }) =>
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
  workspaceCount: number;
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
        workspaceCount: workspaces.list(ctx.db, user.id).length,
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
      return repo(() => auth.setUserLimits(ctx.db, input.userId, patch));
    }),
  /**
   * Codes an administrator hands out. `createdBy` is null rather than the
   * admin's id because `invites.created_by` is spent against that account's
   * `invites_remaining` allotment, which exists for the user-invites-user path
   * (`06-auth-and-users.md` §3) and would cap an administrator at zero.
   */
  createInvites: adminProcedure
    .input(z.object({ count: z.number().int().min(1).max(100) }))
    .mutation(({ ctx, input }) => {
      ctx.logger.info({ adminId: ctx.user.id, count: input.count }, "minted invite codes");
      return { codes: repo(() => auth.createInvites(ctx.db, null, input.count)) };
    }),
});
