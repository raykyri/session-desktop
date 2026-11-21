// CSRF and origin policy (`06-auth-and-users.md` §5).
//
// CSRF protection: validates request origin and requires X-Requested-With header on mutations
// to block un-preflighted cross-origin requests.

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
 * an absent header is not by itself a failure. Rejects null origins from sandboxed iframes, data URLs, and cross-scheme redirects.
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

/** The API prefixes whose GETs are guarded too: tRPC subscriptions, the sync
 * snapshot, pull and event stream, and run reads, so a cross-site page cannot
 * open a cookie SSE stream or read a snapshot (plan `04` Z2). */
const GUARDED_GET_PREFIXES = ["/api/trpc", "/api/sync/", "/api/runs/"];

/** Whether the request requires same-origin CSRF verification. `path` is
 * the path as the router matches it (`c.req.path`, percent-decoded), so an
 * encoded spelling of a guarded path (`/api/%73ync/pull`) is guarded too. */
function isGuarded(method: string, path: string): boolean {
  if (!SAFE_METHODS.has(method)) {
    return true;
  }
  return GUARDED_GET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Paths whose only credential is the session cookie (plan `04` Z4). */
const COOKIE_ONLY_PREFIXES = ["/api/trpc", "/api/sync/", "/api/runs/"];

/**
 * A request to the API that carries an `Authorization` header answers 400:
 * the session cookie is the only credential the web server accepts, and a
 * bearer token it does not accept is refused rather than ignored (04 Z4).
 * `/metrics` keeps its own bearer token and is not under these prefixes.
 */
export function rejectAuthorizationHeader(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (
      c.req.header("authorization") !== undefined &&
      COOKIE_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      return c.json({ error: "This API accepts the session cookie only." }, 400);
    }
    return next();
  };
}

export function csrfGuard(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // the decoded path the router matches, not the raw pathname
    const path = c.req.path;
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
      return c.json(
        { error: `Missing required ${REQUESTED_WITH_HEADER}: session header for mutation` },
        403,
      );
    }
    return next();
  };
}
