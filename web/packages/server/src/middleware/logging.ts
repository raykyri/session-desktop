// One JSON line per request: method, path, status, duration.
//
// Paths that carry a secret in their last segment are logged with the
// segment replaced: a widget page token (`/w/<token>`), an artifact token
// (`/a/<token>`) and a thread invitation (`/invite/<token>`, the SPA route an
// invitation link opens). Query strings are never logged.

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../deps.js";

const SECRET_PATH = /^\/(a|w|invite)\/[^/]+\/?$/u;

/** The path as the access log records it: a token in the last segment of a
 * secret-bearing path is replaced with `[redacted]`. */
export function loggedPath(pathname: string): string {
  return pathname.replace(SECRET_PATH, "/$1/[redacted]");
}

export function requestLogging(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      const logger = c.get("logger");
      const fields = {
        method: c.req.method,
        path: loggedPath(new URL(c.req.url).pathname),
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
