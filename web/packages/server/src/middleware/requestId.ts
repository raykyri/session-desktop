// A request id on every request and every log line, and the client address the
// rate limiters key on.

import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../deps.js";
import type { Logger } from "../logger.js";

/** Fly terminates TLS and forwards the client address in `Fly-Client-IP`;
 * `X-Forwarded-For` is the fallback and its first entry is the client. */
export function clientIpFrom(headers: Headers): string {
  const fly = headers.get("fly-client-ip");
  if (fly) {
    return fly.trim();
  }
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return "unknown";
}

export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.set("clientIp", clientIpFrom(c.req.raw.headers));
    c.set("logger", logger.child({ requestId }));
    c.set("user", null);
    c.set("sessionToken", null);
    c.header("X-Request-Id", requestId);
    await next();
  };
}
