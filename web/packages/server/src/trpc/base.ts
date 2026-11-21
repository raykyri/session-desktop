// tRPC v11 initialization: the context, the procedure kinds, and the
// per-user and per-IP abuse limits (`03-api-and-events.md` §1,
// `06-auth-and-users.md` §4, §8, plan `04` Z1).

import type { SessionDatabase } from "@session/db";
import type { ModelEntry, User } from "@session/shared";
import { MODEL_REGISTRY } from "@session/shared";
import { TRPCError, initTRPC } from "@trpc/server";

import { hashClientIp } from "../auth/session.js";
import type { Config } from "../config.js";
import type { ServerDeps } from "../deps.js";
import { storedAllowances } from "../keys/allowances.js";
import type { Logger } from "../logger.js";
import type { AbuseBucket, RateLimiter } from "../middleware/rateLimit.js";
import { abuseBuckets, writesKey } from "../middleware/rateLimit.js";
import type { Allowances } from "../runs/allowance.js";
import type { Ledger } from "../runs/ledger.js";
import { MemoryLedger } from "../runs/memoryLedger.js";
import type { RunTexts } from "../runs/runTexts.js";
import { UNAVAILABLE_RUN_TEXTS } from "../runs/runTexts.js";
import type { SecretBox } from "../secretBox.js";
import { createSecretBox } from "../secretBox.js";
import { EMPTY_DIRECTORY, type SpaceDirectory } from "../spaces/directory.js";
import type { SyncService } from "../sync/service.js";

export interface AppContext {
  config: Config;
  db: SessionDatabase;
  logger: Logger;
  limiter: RateLimiter;
  fetch: typeof globalThis.fetch;
  user: User | null;
  clientIp: string;
  /** The hashed per-IP limit key (IPv6 by /64 prefix). */
  ipKey: string;
  /** The cookie this request arrived with, so `auth.logout` can end this
   * session and leave the account's other browsers signed in. */
  sessionToken: string | null;
  /** The sync core, whose event streams sign-out ends. */
  sync: SyncService | undefined;
  ledger: Ledger;
  /** A member's weekly allowance, keys and billing (`03` K3, K4, K7), as
   * the run loop reads them. */
  allowances: Allowances;
  runTexts: RunTexts;
  models: readonly ModelEntry[];
  /** Seals and opens stored API keys under `SESSION_SECRET_KEY`. */
  box: SecretBox;
  keyCheckTimeoutMs: number | undefined;
  now: () => number;
  /** The open channels, for `spaces.directory`. */
  directory: SpaceDirectory;
}

export interface ContextInput {
  user: User | null;
  clientIp?: string;
  ipKey?: string;
  sessionToken?: string | null;
}

export function createAppContext(
  deps: ServerDeps,
  limiter: RateLimiter,
  logger: Logger,
  input: ContextInput,
): AppContext {
  const clientIp = input.clientIp ?? "unknown";
  const box = createSecretBox(deps.config.secretKey);
  return {
    config: deps.config,
    db: deps.db,
    logger,
    limiter,
    fetch: deps.fetch ?? globalThis.fetch,
    user: input.user,
    clientIp,
    ipKey: input.ipKey ?? hashClientIp(deps.config, clientIp),
    sessionToken: input.sessionToken ?? null,
    sync: deps.sync,
    ledger: deps.ledger ?? new MemoryLedger(),
    allowances:
      deps.allowances ??
      storedAllowances({
        db: deps.db,
        box,
        logger,
        config: deps.config,
        ...(deps.now ? { now: deps.now } : {}),
      }),
    runTexts: deps.runTexts ?? UNAVAILABLE_RUN_TEXTS,
    models: deps.models ?? MODEL_REGISTRY,
    box,
    keyCheckTimeoutMs: deps.keyCheckTimeoutMs,
    now: deps.now ?? Date.now,
    directory: deps.directory ?? EMPTY_DIRECTORY,
  };
}

const t = initTRPC.context<AppContext>().create();

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;
export const mergeRouters = t.mergeRouters;

/** No session required; `ctx.user` is null for a signed-out caller. */
export const publicProcedure = t.procedure;

/** The refusal every limit answers; recorded nowhere (04 Z1). */
export function tooManyRequests(): TRPCError {
  return new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: "too many requests at once; try again in a moment",
  });
}

/** Takes one token from `bucket` under `key`, or throws the refusal. */
export function takeOrRefuse(ctx: AppContext, bucket: AbuseBucket, key: string): void {
  const spec = abuseBuckets(ctx.config.abuse)[bucket];
  if (!ctx.limiter.take(`${bucket}:${key}`, spec).allowed) throw tooManyRequests();
}

/** 60 mutations a minute per account (`06` §8, `04` Z1 "Replicated
 * writes"), in the one bucket `/api/sync/apply` takes from too
 * (`writesKey`). Queries are cheap and cacheable; a mutation is a write. */
const mutationBudget = t.middleware(({ ctx, type, next }) => {
  if (type === "mutation" && ctx.user !== null) {
    const spec = abuseBuckets(ctx.config.abuse).writes;
    const result = ctx.limiter.take(writesKey(ctx.user.id), spec);
    if (!result.allowed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "too many changes at once; try again in a moment",
      });
    }
  }
  return next();
});

/**
 * A per-IP or per-user bucket on a procedure (04 Z1). `ip` keys on the
 * hashed IP key; `user` on the signed-in account; `userOrIp` on the account
 * when there is one. `auth` is the bucket the `/auth/*` routes share.
 */
export function limit(bucket: AbuseBucket, by: "ip" | "user" | "userOrIp") {
  return t.middleware(({ ctx, next }) => {
    const key =
      by === "ip" || (by === "userOrIp" && ctx.user === null)
        ? `ip:${ctx.ipKey}`
        : `user:${ctx.user?.id ?? "anonymous"}`;
    takeOrRefuse(ctx, bucket, key);
    return next();
  });
}

const requireUser = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in to continue" });
  }
  return next({ ctx: { ...ctx, user: ctx.user, userId: ctx.user.id, isAdmin: ctx.user.isAdmin } });
});

/** An active account: a waiting one has no handle and cannot write. */
const requireMember = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in to continue" });
  }
  if (ctx.user.status !== "active") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You can do this once your account is active.",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user, userId: ctx.user.id, isAdmin: ctx.user.isAdmin } });
});

const requireAdmin = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in to continue" });
  }
  if (!ctx.user.isAdmin || ctx.user.status !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "this is an administrator action" });
  }
  return next({ ctx: { ...ctx, user: ctx.user, userId: ctx.user.id, isAdmin: true } });
});

/** Any signed-in account, waiting or active. */
export const protectedProcedure = t.procedure.use(mutationBudget).use(requireUser);

/** Active accounts only (04 I2, I3). */
export const memberProcedure = t.procedure.use(mutationBudget).use(requireMember);

export const adminProcedure = t.procedure.use(mutationBudget).use(requireAdmin);
