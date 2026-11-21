// Session cookie management and authentication middleware
// (`06-auth-and-users.md` §1, §4).

import { createHmac } from "node:crypto";

import { auth, users } from "@session/db";
import type { User } from "@session/shared";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { Config } from "../config.js";
import type { AppEnv, ServerDeps } from "../deps.js";
import { ipLimitKey } from "../net/ipKey.js";

export const SESSION_COOKIE = "session";

/** 30-day session cookie lifetime, matching idle expiry enforced by `sessions` records. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function setSessionCookie(c: Context<AppEnv>, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // In development, non-TLS `http://localhost` rejects `Secure` cookies.
    secure: config.isProduction,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(c: Context<AppEnv>, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
  });
}

export function sessionCookieFrom(c: Context<AppEnv>): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null;
}

/**
 * The per-IP key of the abuse limits and of `signup_attempts` (04 Z1): the
 * address, or its /64 prefix for IPv6 (`ipLimitKey`), under an HMAC keyed
 * with `SESSION_SECRET_KEY`, so a database read gives no addresses and the
 * IPv4 space cannot be enumerated against it.
 */
export function hashClientIp(config: Config, ip: string): string {
  return createHmac("sha256", config.secretKey).update(ipLimitKey(ip), "utf8").digest("hex");
}

/** Publishes `ipKey`, the hashed limit key of the client address. After
 * `requestContext`, which sets `clientIp`. */
export function clientKey(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("ipKey", hashClientIp(config, c.get("clientIp")));
    await next();
  };
}

export function userForToken(deps: ServerDeps, token: string | null): User | null {
  if (token === null || token === "") {
    return null;
  }
  const session = auth.readSession(deps.db, token);
  if (!session) {
    return null;
  }
  return users.findById(deps.db, session.userId);
}

/** Attaches the authenticated user to the request context. Unauthenticated requests are permitted and handled by downstream procedure guards. */
export function sessionLoader(deps: ServerDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = sessionCookieFrom(c);
    c.set("sessionToken", token);
    c.set("user", userForToken(deps, token));
    await next();
  };
}

/**
 * Deletes the session identified by `token`. Other sessions for the account
 * remain unchanged.
 *
 * The research event stream that sign-out also closed was removed with the
 * research API (plan `01` A2). The sync SSE stream of `01` Y7 (M3) is to be
 * closed here too, and checked against session expiry while it is open.
 */
export function endSession(deps: Pick<ServerDeps, "db">, token: string): void {
  auth.deleteSession(deps.db, token);
}
