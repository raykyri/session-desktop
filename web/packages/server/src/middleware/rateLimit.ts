// In-memory token bucket rate limiting for single-process deployments.

import type { MiddlewareHandler } from "hono";

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
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until one token is available again. */
  retryAfter: number;
}

/** The limits from `06` §8, named so the call sites read as the document does. */
export const RATE_LIMITS = {
  mutations: { limit: 60, windowMs: 60_000 },
  auth: { limit: 20, windowMs: 60_000 },
  /** `apiKeys.set` per account: each call makes a request to a provider
   * with a key someone pasted (`03` K4). */
  apiKeyChecks: { limit: 5, windowMs: 600_000 },
  /** `apiKeys.set` across all accounts. */
  apiKeyChecksGlobal: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, BucketSpec>;

/** The bucket spec with the longest refill window, the default for `sweep`. */
const LONGEST_WINDOW: BucketSpec = Object.values(RATE_LIMITS).reduce((longest, spec) =>
  spec.windowMs > longest.windowMs ? spec : longest,
);

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #held = new Set<string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  take(key: string, spec: BucketSpec, cost = 1): RateLimitResult {
    const at = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: spec.limit, updatedAt: at };
    const refill = ((at - bucket.updatedAt) / spec.windowMs) * spec.limit;
    const tokens = Math.min(spec.limit, bucket.tokens + Math.max(0, refill));
    if (tokens < cost) {
      this.#buckets.set(key, { tokens, updatedAt: at });
      const perToken = spec.windowMs / spec.limit;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(((cost - tokens) * perToken) / 1000)),
      };
    }
    this.#buckets.set(key, { tokens: tokens - cost, updatedAt: at });
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

  /** Evicts expired rate limit buckets to bound memory usage in long-running
   * processes. `spec` should carry the longest window in use, so no bucket
   * that could still be limiting is evicted. */
  sweep(spec: BucketSpec = LONGEST_WINDOW): number {
    const at = this.#now();
    let removed = 0;
    for (const [key, bucket] of [...this.#buckets.entries()]) {
      if (at - bucket.updatedAt > spec.windowMs) {
        this.#buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Limits a plain HTTP route by client address. */
export function rateLimitByIp(
  limiter: RateLimiter,
  scope: string,
  spec: BucketSpec,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = limiter.take(`${scope}:ip:${c.get("clientIp")}`, spec);
    if (!result.allowed) {
      return c.json({ error: "Rate limit exceeded. Please try again shortly." }, 429, {
        "Retry-After": String(result.retryAfter),
      });
    }
    return next();
  };
}
