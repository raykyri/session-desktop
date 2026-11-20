// A request id on every request and every log line, and the client address the
// rate limiters key on.

import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../deps.js";
import type { Logger } from "../logger.js";

/** The client's network address: from `header` when the platform's proxy
 * sets it (`SESSION_CLIENT_IP_HEADER`: Fly terminates TLS and replaces any
 * `Fly-Client-IP` a client sends), else the socket's. Never from a header a
 * client can set, such as `X-Forwarded-For` (review round 1 of phase 2: the
 * address decides a one-click device sign-in). "unknown" when there is
 * neither (a test's `app.request`). */
export function clientIpFrom(
  headers: Headers,
  header: string | null,
  socket: string | undefined,
): string {
  const fromProxy = header ? headers.get(header)?.trim() : undefined;
  if (fromProxy) {
    return fromProxy;
  }
  return socket?.trim() || "unknown";
}

/** The socket's remote address under @hono/node-server, if any. */
function socketAddress(env: unknown): string | undefined {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress;
}

export function requestContext(
  logger: Logger,
  clientIpHeader: string | null = "fly-client-ip",
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.set("clientIp", clientIpFrom(c.req.raw.headers, clientIpHeader, socketAddress(c.env)));
    c.set("logger", logger.child({ requestId }));
    c.set("user", null);
    c.set("sessionToken", null);
    c.header("X-Request-Id", requestId);
    await next();
  };
}
