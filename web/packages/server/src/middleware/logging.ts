// One JSON line per request: method, path, status, duration.

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../deps.js";

export function requestLogging(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      const logger = c.get("logger");
      const fields = {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        userId: c.get("user")?.id ?? null,
      };
      if (c.res.status >= 500) {
        logger.error(fields, "request failed");
      } else {
        logger.info(fields, "request");
      }
    }
  };
}
