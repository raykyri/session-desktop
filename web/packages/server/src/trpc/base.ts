// tRPC v11 initialization: the context, the three procedure kinds, and the
// per-user mutation budget (`03-api-and-events.md` §1,
// `06-auth-and-users.md` §4, §8).

import type { SessionDatabase } from "@session/db";
import type { User } from "@session/shared";
import { TRPCError, initTRPC } from "@trpc/server";

import type { Config } from "../config.js";
import type { ServerDeps } from "../deps.js";
import type { EventBus } from "../events/bus.js";
import type { Logger } from "../logger.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { RATE_LIMITS } from "../middleware/rateLimit.js";
import type { RunsService } from "../runs/service.js";

export interface AppContext {
  config: Config;
  db: SessionDatabase;
  eventBus: EventBus;
  runs: RunsService;
  logger: Logger;
  limiter: RateLimiter;
  fetch: typeof globalThis.fetch;
  user: User | null;
  clientIp: string;
  /** The cookie this request arrived with, so `auth.logout` can end this
   * session and leave the account's other browsers signed in. */
  sessionToken: string | null;
}

export interface ContextInput {
  user: User | null;
  clientIp?: string;
  sessionToken?: string | null;
}

export function createAppContext(
  deps: ServerDeps,
  limiter: RateLimiter,
  logger: Logger,
  input: ContextInput,
): AppContext {
  return {
    config: deps.config,
    db: deps.db,
    eventBus: deps.eventBus,
    runs: deps.runs,
    logger,
    limiter,
    fetch: deps.fetch ?? globalThis.fetch,
    user: input.user,
    clientIp: input.clientIp ?? "unknown",
    sessionToken: input.sessionToken ?? null,
  };
}

const t = initTRPC.context<AppContext>().create({
  // Heartbeat comments keep proxies from closing an idle stream, and the
  // client's inactivity timeout is what turns a dead connection into a
  // reconnect-and-refetch (`05-run-lifecycle-and-streaming.md` §4).
  sse: {
    ping: { enabled: true, intervalMs: 20_000 },
    client: { reconnectAfterInactivityMs: 60_000 },
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;
export const mergeRouters = t.mergeRouters;

/** No session required: `system.health` and `auth.*` only. */
export const publicProcedure = t.procedure;

/** 60 mutations a minute per account (`06` §8). Queries are cheap and
 * cacheable; a mutation is a write. */
const mutationBudget = t.middleware(({ ctx, type, next }) => {
  if (type === "mutation" && ctx.user !== null) {
    const result = ctx.limiter.take(`mutations:${ctx.user.id}`, RATE_LIMITS.mutations);
    if (!result.allowed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "too many changes at once; try again in a moment",
      });
    }
  }
  return next();
});

const requireUser = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in to continue" });
  }
  return next({ ctx: { ...ctx, user: ctx.user, userId: ctx.user.id, isAdmin: ctx.user.isAdmin } });
});

const requireAdmin = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in to continue" });
  }
  if (!ctx.user.isAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "this is an administrator action" });
  }
  return next({ ctx: { ...ctx, user: ctx.user, userId: ctx.user.id, isAdmin: true } });
});

export const protectedProcedure = t.procedure.use(mutationBudget).use(requireUser);

export const adminProcedure = t.procedure.use(mutationBudget).use(requireAdmin);
