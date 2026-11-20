// The web shell's account routes (phase 2b; ADR-19 as amended): plain JSON
// routes in place of the tRPC procedures the shell used in phase 2a.
//
//   GET  /api/config               the runtime configuration (models, limits)
//   GET  /api/me/preferences       the appearance settings (`UserSettings`)
//   POST /api/me/preferences       { settings?, researchLaunchInstruction? }
//   GET  /api/me/usage/daily       today's usage against the daily limits
//   GET  /api/admin/users          admins: every account with usage and limits
//   POST /api/admin/limits         admins: { userId, dailyTokens?, dailyRuns? }
//   POST /api/admin/invites        admins: { count } sign-up codes
//
// A write answers 401 signed out and 429 past the account's write budget (60
// a minute). A device's bearer token signs in to the sync API only, never to
// these. Errors are `{ error: { code, message } }`.

import { auth, preferences, usage, users } from "@session/db";
import type { User, UserSettings } from "@session/shared";
import { clampResearchLaunchInstruction, userSettingsSchema } from "@session/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv, ServerDeps } from "../deps.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { RATE_LIMITS } from "../middleware/rateLimit.js";

import { runtimeConfigFor } from "./config.js";

export interface StoredSettings extends UserSettings {
  researchLaunchInstruction: string | null;
}

/** One UTC day of usage. */
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

type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

const fail = (c: Context<AppEnv>, code: ErrorCode, message: string) =>
  c.json({ error: { code, message } }, STATUS[code] as 400);

/** The signed-in browser's account: a device token signs in to the sync API,
 * not to the browser's account routes. */
const browserUser = (c: Context<AppEnv>): User | null => (c.get("bearer") ? null : c.get("user"));

function readSettings(db: ServerDeps["db"], userId: string): StoredSettings {
  const stored = preferences.ensure(db, userId);
  return { ...stored.settings, researchLaunchInstruction: stored.researchLaunchInstruction };
}

const preferencesInput = z.strictObject({
  settings: userSettingsSchema.partial().optional(),
  researchLaunchInstruction: z.string().nullable().optional(),
});

const limitsInput = z.strictObject({
  userId: z.string(),
  dailyTokens: z.number().int().min(0).nullable().optional(),
  dailyRuns: z.number().int().min(0).nullable().optional(),
});

const invitesInput = z.strictObject({ count: z.number().int().min(1).max(100) });

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    return undefined;
  }
}

export function accountRoutes(deps: ServerDeps, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, config } = deps;

  /** The signed-in account for a write, after its budget; or the answer. */
  const writer = (c: Context<AppEnv>): User | Response => {
    const user = browserUser(c);
    if (!user) return fail(c, "UNAUTHORIZED", "Sign in to continue.");
    if (!limiter.take(`mutations:${user.id}`, RATE_LIMITS.mutations).allowed)
      return fail(c, "TOO_MANY_REQUESTS", "Too many changes at once; try again in a moment.");
    return user;
  };
  const admin = (c: Context<AppEnv>): User | Response => {
    const user = browserUser(c);
    if (!user) return fail(c, "UNAUTHORIZED", "Sign in to continue.");
    if (!user.isAdmin) return fail(c, "FORBIDDEN", "This is an administrator action.");
    return user;
  };

  app.get("/api/config", (c) => c.json(runtimeConfigFor(config, browserUser(c))));

  app.get("/api/me/preferences", (c) => {
    const user = browserUser(c);
    if (!user) return fail(c, "UNAUTHORIZED", "Sign in to continue.");
    return c.json(readSettings(db, user.id));
  });

  app.post("/api/me/preferences", async (c) => {
    const user = writer(c);
    if (user instanceof Response) return user;
    const input = preferencesInput.safeParse(await jsonBody(c));
    if (!input.success) return fail(c, "BAD_REQUEST", "Expected { settings?, researchLaunchInstruction? }.");
    const patch: Parameters<typeof preferences.update>[2] = {};
    if (input.data.settings !== undefined) patch.settings = input.data.settings;
    if (input.data.researchLaunchInstruction !== undefined)
      // the 4 KiB limit is `shared`'s, so the composer and the server agree
      patch.researchLaunchInstruction =
        input.data.researchLaunchInstruction === null
          ? null
          : clampResearchLaunchInstruction(input.data.researchLaunchInstruction);
    preferences.update(db, user.id, patch);
    return c.json(readSettings(db, user.id));
  });

  app.get("/api/me/usage/daily", (c) => {
    const user = browserUser(c);
    if (!user) return fail(c, "UNAUTHORIZED", "Sign in to continue.");
    return c.json(
      usage.summary(db, user.id, {
        dailyTokens: config.limits.dailyTokens,
        dailyRuns: config.limits.dailyRuns,
      }),
    );
  });

  app.get("/api/admin/users", (c) => {
    const user = admin(c);
    if (user instanceof Response) return user;
    const list: AdminUser[] = users.listUsers(db).map((u) => ({
      ...u,
      usage: usage.dailyTotals(db, u.id),
      limits: usage.effectiveLimits(db, u.id, {
        dailyTokens: config.limits.dailyTokens,
        dailyRuns: config.limits.dailyRuns,
      }),
    }));
    return c.json(list);
  });

  app.post("/api/admin/limits", async (c) => {
    const user = admin(c);
    if (user instanceof Response) return user;
    const input = limitsInput.safeParse(await jsonBody(c));
    if (!input.success) return fail(c, "BAD_REQUEST", "Expected { userId, dailyTokens?, dailyRuns? }.");
    if (!users.findById(db, input.data.userId))
      return fail(c, "NOT_FOUND", `account ${input.data.userId} was not found`);
    const patch: { dailyTokens?: number | null; dailyRuns?: number | null } = {};
    if (input.data.dailyTokens !== undefined) patch.dailyTokens = input.data.dailyTokens;
    if (input.data.dailyRuns !== undefined) patch.dailyRuns = input.data.dailyRuns;
    const limits: DailyLimits = auth.setUserLimits(db, input.data.userId, patch);
    return c.json(limits);
  });

  /** Admin sign-up codes have no maker, so they draw on no personal allowance. */
  app.post("/api/admin/invites", async (c) => {
    const user = admin(c);
    if (user instanceof Response) return user;
    const input = invitesInput.safeParse(await jsonBody(c));
    if (!input.success) return fail(c, "BAD_REQUEST", "Expected { count } from 1 to 100.");
    c.get("logger").info({ adminId: user.id, count: input.data.count }, "created invite codes");
    return c.json({ codes: auth.createInvites(db, null, input.data.count) });
  });

  return app;
}
