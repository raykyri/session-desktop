// Feeds the request-latency histogram (`13-deployment-fly.md` §7).
//
// Outermost after the request id, so the duration it records is the one a
// client experiences, including the time spent in the rate limiter and the
// CSRF guard. The observation is in a `finally` because a handler that throws
// is exactly the request an operator wants in the histogram.

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../deps.js";
import type { MetricsRegistry } from "../metrics.js";

export function requestMetrics(registry: MetricsRegistry): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      registry.observeRequest(
        c.req.method,
        new URL(c.req.url).pathname,
        c.res.status,
        (performance.now() - startedAt) / 1000,
      );
    }
  };
}
