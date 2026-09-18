// CSRF and origin policy (`06-auth-and-users.md` §5).
//
// Two independent barriers: the request's origin must be ours, and a mutation
// must carry `X-Requested-With: session`, a header a cross-origin form or
// image cannot set without a preflight the server never answers.

import type { MiddlewareHandler } from "hono";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

export const REQUESTED_WITH_HEADER = "x-requested-with";
export const REQUESTED_WITH_VALUE = "session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginCheck {
  ok: boolean;
  reason?: string;
}

/**
 * `Origin` is compared when present; browsers omit it on same-origin GETs, so
 * an absent header is not by itself a failure. The literal `null` origin is
 * not ours — it is what a sandboxed frame, a `data:` document, or a
 * cross-scheme redirect sends — and is refused with the rest.
 * `Sec-Fetch-Site: cross-site` is rejected outright: it is set by the browser
 * and cannot be forged by page script.
 */
export function checkOrigin(headers: Headers, publicOrigin: string): OriginCheck {
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site") {
    return { ok: false, reason: "cross-site request" };
  }
  const origin = headers.get("origin");
  if (origin !== null && origin !== publicOrigin) {
    return { ok: false, reason: "origin mismatch" };
  }
  return { ok: true };
}

/** Whether this request has to prove it came from our own page. */
function isGuarded(method: string, path: string): boolean {
  if (!SAFE_METHODS.has(method)) {
    return true;
  }
  // Subscriptions are GETs and are guarded too (`03-api-and-events.md` §1).
  return path.startsWith("/api/trpc");
}

export function csrfGuard(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    if (!isGuarded(method, path)) {
      return next();
    }
    const origin = checkOrigin(c.req.raw.headers, config.publicOrigin);
    if (!origin.ok) {
      return c.json({ error: origin.reason ?? "forbidden" }, 403);
    }
    if (
      !SAFE_METHODS.has(method) &&
      c.req.header(REQUESTED_WITH_HEADER)?.toLowerCase() !== REQUESTED_WITH_VALUE
    ) {
      return c.json({ error: `mutations require ${REQUESTED_WITH_HEADER}: session` }, 403);
    }
    return next();
  };
}
