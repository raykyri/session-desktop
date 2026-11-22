// In-memory token buckets for the abuse limits of plan `04` Z1 (single
// process, `06` §8). A refusal answers `TOO_MANY_REQUESTS` (HTTP 429) and
// records nothing.
//
// The per-day and per-hour limits of the mutators' `pre` stage (channels
// made, channel invite links made, joins) are sliding logs instead: the
// times of the person's uses in the last window, so "5 a day" is at most 5
// in any 24 hours. A token bucket refills continuously, which lets a full
// bucket's 5 and the 5 that refill through in one day.

import type { PreLimit } from "@session/mutators";
import type { PreLimits } from "@session/sync/server";
import type { MiddlewareHandler } from "hono";

import type { AbuseLimits } from "../config.js";
import type { AppEnv } from "../deps.js";

export interface BucketSpec {
  /** Bucket capacity, which is also the burst allowance. */
  limit: number;
  /** Milliseconds the bucket takes to refill from empty. */
  windowMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  windowMs: number;
}

/** A sliding log: the times of the uses in the last `windowMs`, oldest
 * first. */
interface UseLog {
  uses: number[];
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until one token is available again. */
  retryAfter: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The `06` §8 defaults, kept for callers outside a configured server. */
export const RATE_LIMITS = {
  mutations: { limit: 60, windowMs: MINUTE },
  auth: { limit: 20, windowMs: MINUTE },
  /** `apiKeys.set` per account: each call makes a request to a provider
   * with a key someone pasted (`03` K4). */
  apiKeyChecks: { limit: 5, windowMs: 10 * MINUTE },
  /** `apiKeys.set` across all accounts. */
  apiKeyChecksGlobal: { limit: 60, windowMs: MINUTE },
} as const satisfies Record<string, BucketSpec>;

/** The buckets of `04` Z1 from the configured limits. */
export function abuseBuckets(limits: AbuseLimits) {
  return {
    /** Replicated writes and tRPC mutations, per user. */
    writes: { limit: limits.writesPerMinute, windowMs: MINUTE },
    /** `/api/sync/snapshot`, `/pull` and `/read`, per user, or per IP signed
     * out. */
    snapshots: { limit: limits.snapshotsPerMinute, windowMs: MINUTE },
    /** A `/api/sync/read` of `threads` reads only (a thread opened), per
     * user. */
    threadReads: { limit: limits.threadReadsPerMinute, windowMs: MINUTE },
    /** … per IP signed out. */
    threadReadsSignedOut: { limit: limits.threadReadsPerIpPerMinute, windowMs: MINUTE },
    /** Opening `/api/sync/events`, per user. */
    streamOpens: { limit: limits.streamOpensPerMinute, windowMs: MINUTE },
    /** `spaces.byName`, per user or IP, besides the directory's bucket; each
     * call of a tRPC batch counts. */
    byName: { limit: limits.byNamePerMinute, windowMs: MINUTE },
    /** `/auth/*`, `auth.checkInvite`, `accountInvites.redeem`,
     * `account.create`, per IP. */
    auth: { limit: limits.authPerMinute, windowMs: MINUTE },
    /** Failed invite checks, per IP and per user. */
    failedChecks: { limit: limits.failedChecksPerHour, windowMs: HOUR },
    /** `accountInvites.create`, per user. */
    invitesCreated: { limit: limits.invitesPerDay, windowMs: DAY },
    /** `accountInvites.list` and `members.tree`, per user. */
    inviteReads: { limit: limits.inviteReadsPerMinute, windowMs: MINUTE },
    /** Handle availability at the profile step, per user. */
    handleChecks: { limit: limits.handleChecksPerMinute, windowMs: MINUTE },
    /** `spaces.create`, per user, counted in the mutator's `pre` stage. */
    spacesCreated: { limit: limits.spacesPerDay, windowMs: DAY },
    /** `invites.create` (channel invite links), per user, in `pre`. */
    channelInvites: { limit: limits.channelInvitesPerDay, windowMs: DAY },
    /** `spaces.join`, per user, in `pre`. */
    joins: { limit: limits.joinsPerHour, windowMs: HOUR },
    /** `spaces.directory` and `spaces.byName`, per user or per IP. */
    directory: { limit: limits.directoryPerMinute, windowMs: MINUTE },
    /** `admin.models.*` and `admin.invites.*`, per site admin. */
    adminModels: { limit: limits.adminPerMinute, windowMs: MINUTE },
  } as const satisfies Record<string, BucketSpec>;
}

export type AbuseBucket = keyof ReturnType<typeof abuseBuckets>;

/** The writes bucket's key for an account: `/api/sync/apply` and every tRPC
 * mutation take from it (`04` Z1). */
export const writesKey = (userId: string): string => `writes:user:${userId}`;

/** The bucket each `pre`-stage limit of a mutator counts in, and what its
 * refusal says the limit is. */
const PRE_BUCKETS = {
  "spaces.create": { bucket: "spacesCreated", what: "create", things: "channels" },
  "invites.create": { bucket: "channelInvites", what: "make", things: "channel invite links" },
  "spaces.join": { bucket: "joins", what: "join", things: "channels" },
} as const satisfies Record<PreLimit, { bucket: AbuseBucket; what: string; things: string }>;

/** A window's length in words: "a day", "an hour", "a minute", or minutes. */
function per(windowMs: number): string {
  if (windowMs === DAY) return "a day";
  if (windowMs === HOUR) return "an hour";
  if (windowMs === MINUTE) return "a minute";
  return `in ${Math.round(windowMs / MINUTE)} minutes`;
}

/** How long until a use is free again, in words, rounded up: minutes below
 * two hours, hours above. */
function wait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 120) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}

/** The message of a limit's refusal: the limit, and when a use is free
 * again ("You can make 10 invite links a day. Try again in 3 hours.").
 * `retryAfter` is in seconds. */
export function limitMessage(
  what: string,
  things: string,
  spec: BucketSpec,
  retryAfter: number,
): string {
  return `You can ${what} ${spec.limit} ${things} ${per(spec.windowMs)}. Try again in ${wait(retryAfter)}.`;
}

/** The message of a `pre`-stage refusal ("You can create 5 channels a day.
 * Try again in 3 hours."). */
export function preLimitMessage(limit: PreLimit, spec: BucketSpec, retryAfter: number): string {
  const { what, things } = PRE_BUCKETS[limit];
  return limitMessage(what, things, spec, retryAfter);
}

/** The `pre`-stage limits of `04` Z1 over `limiter`'s sliding logs, keyed
 * by the person's handle (`SyncServer.setPreLimits`). */
export function preLimits(limiter: RateLimiter, limits: AbuseLimits): PreLimits {
  const buckets = abuseBuckets(limits);
  const keyOf = (u: string, limit: PreLimit) => `${PRE_BUCKETS[limit].bucket}:user:${u}`;
  const specOf = (limit: PreLimit) => buckets[PRE_BUCKETS[limit].bucket];
  return {
    check: (u, limit) => {
      const spec = specOf(limit);
      const left = limiter.checkLog(keyOf(u, limit), spec);
      return left.allowed ? true : preLimitMessage(limit, spec, left.retryAfter);
    },
    take: (u, limit) => limiter.useLog(keyOf(u, limit), specOf(limit)),
  };
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #logs = new Map<string, UseLog>();
  readonly #held = new Set<string>();
  readonly #refusals = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #refill(key: string, spec: BucketSpec, at: number): number {
    const bucket = this.#buckets.get(key) ?? {
      tokens: spec.limit,
      updatedAt: at,
      windowMs: spec.windowMs,
    };
    const refill = ((at - bucket.updatedAt) / spec.windowMs) * spec.limit;
    return Math.min(spec.limit, bucket.tokens + Math.max(0, refill));
  }

  take(key: string, spec: BucketSpec, cost = 1): RateLimitResult {
    const at = this.#now();
    const tokens = this.#refill(key, spec, at);
    if (tokens < cost) {
      this.#buckets.set(key, { tokens, updatedAt: at, windowMs: spec.windowMs });
      const scope = key.split(":")[0] ?? key;
      this.#refusals.set(scope, (this.#refusals.get(scope) ?? 0) + 1);
      const perToken = spec.windowMs / spec.limit;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(((cost - tokens) * perToken) / 1000)),
      };
    }
    this.#buckets.set(key, { tokens: tokens - cost, updatedAt: at, windowMs: spec.windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  /** Takes the one slot `key` has, for work that must not run twice at once
   * (one API key check per account, `03` K4). Returns the release, or null
   * while the slot is held. */
  hold(key: string): (() => void) | null {
    if (this.#held.has(key)) return null;
    this.#held.add(key);
    return () => {
      this.#held.delete(key);
    };
  }

  /** Whether `cost` tokens are available, without taking them. */
  has(key: string, spec: BucketSpec, cost = 1): boolean {
    return this.#refill(key, spec, this.#now()) >= cost;
  }

  /** The uses of `key`'s sliding log in the last `spec.windowMs`. */
  #recent(key: string, spec: BucketSpec, at: number): number[] {
    return (this.#logs.get(key)?.uses ?? []).filter((t) => t > at - spec.windowMs);
  }

  /** Whether `key` had fewer than `spec.limit` uses in the last
   * `spec.windowMs`, without using one. A refusal is counted for
   * `/metrics`; `retryAfter` is when the oldest of them leaves the window. */
  checkLog(key: string, spec: BucketSpec): RateLimitResult {
    const at = this.#now();
    const uses = this.#recent(key, spec, at);
    if (uses.length < spec.limit) return { allowed: true, retryAfter: 0 };
    const scope = key.split(":")[0] ?? key;
    this.#refusals.set(scope, (this.#refusals.get(scope) ?? 0) + 1);
    const oldest = uses[uses.length - spec.limit] ?? at;
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((oldest + spec.windowMs - at) / 1000)),
    };
  }

  /** Records one use of `key`'s sliding log. */
  useLog(key: string, spec: BucketSpec): void {
    const at = this.#now();
    this.#logs.set(key, { uses: [...this.#recent(key, spec, at), at], windowMs: spec.windowMs });
  }

  /** Refusals per bucket scope since the process started, for
   * `session_rate_limited_total{bucket}` (`05` §4). */
  refusals(): ReadonlyMap<string, number> {
    return this.#refusals;
  }

  /** Evicts buckets idle for longer than their own window, which are full
   * again, and sliding logs whose last use left their window, to bound
   * memory in a long-running process. */
  sweep(): number {
    const at = this.#now();
    let removed = 0;
    for (const [key, bucket] of [...this.#buckets.entries()]) {
      if (at - bucket.updatedAt > bucket.windowMs) {
        this.#buckets.delete(key);
        removed += 1;
      }
    }
    for (const [key, log] of [...this.#logs.entries()]) {
      if (at - (log.uses[log.uses.length - 1] ?? 0) > log.windowMs) {
        this.#logs.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/** The 429 body of a plain HTTP route. */
export const RATE_LIMITED_MESSAGE = "Rate limit exceeded. Please try again shortly.";

/** Limits a plain HTTP route by the client's IP key (`ipKey`: the address,
 * or its /64 prefix for IPv6). */
export function rateLimitByIp(
  limiter: RateLimiter,
  scope: string,
  spec: BucketSpec,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = limiter.take(`${scope}:ip:${c.get("ipKey")}`, spec);
    if (!result.allowed) {
      return c.json({ error: RATE_LIMITED_MESSAGE }, 429, {
        "Retry-After": String(result.retryAfter),
      });
    }
    return next();
  };
}

/**
 * Limits a plain HTTP route per signed-in user, or per IP key signed out.
 * Mounted on the route's own path (`/api/runs/:id/live`), so it counts only
 * requests to that route.
 */
export function rateLimitByUserOrIp(
  limiter: RateLimiter,
  scope: string,
  spec: BucketSpec,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const key = user ? `${scope}:user:${user.id}` : `${scope}:ip:${c.get("ipKey")}`;
    const result = limiter.take(key, spec);
    if (!result.allowed) {
      return c.json({ error: RATE_LIMITED_MESSAGE }, 429, {
        "Retry-After": String(result.retryAfter),
      });
    }
    return next();
  };
}
