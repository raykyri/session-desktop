// Session cookie management and authentication middleware
// (`06-auth-and-users.md` §1, §4).

import { createHmac, randomBytes } from "node:crypto";

import { auth, users } from "@session/db";
import type { User } from "@session/shared";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { Config } from "../config.js";
import type { AppEnv, ServerDeps } from "../deps.js";

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
 * Hashes client IP addresses stored in `signup_attempts`. Uses the deployment's
 * GitHub client secret as HMAC salt to prevent rainbow table and enumeration
 * attacks against IPv4 space. If GitHub credentials are not configured, falls
 * back to an ephemeral process-level random salt.
 */
const FALLBACK_IP_SALT = randomBytes(32).toString("hex");

export function hashClientIp(config: Config, ip: string): string {
  const salt = config.github.clientSecret ?? FALLBACK_IP_SALT;
  return createHmac("sha256", salt).update(ip, "utf8").digest("hex");
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

/** Interval for checking open event streams against sessions, ensuring a
 * stream exceeds its session expiry by at most this duration. Sign-out and
 * deletion terminate a session's streams immediately (`endSession`). */
export const SESSION_STREAM_CHECK_MS = 60_000;

/**
 * Deletes the session identified by `token` and closes associated event
 * streams. Other sessions and streams for the account remain unchanged.
 */
export function endSession(deps: Pick<ServerDeps, "db" | "eventBus">, token: string): void {
  auth.deleteSession(deps.db, token);
  deps.eventBus.closeSession(auth.hashSessionToken(token));
}

/**
 * Closes event streams whose session no longer exists or has exceeded idle or
 * absolute expiry. Returns the number of closed connections. Runs every
 * `SESSION_STREAM_CHECK_MS`.
 */
export function closeEndedSessionStreams(
  deps: Pick<ServerDeps, "db" | "eventBus">,
  at: number = Date.now(),
): number {
  let closed = 0;
  for (const sessionId of deps.eventBus.openSessionIds()) {
    if (!auth.sessionIsLive(deps.db, sessionId, at)) {
      closed += deps.eventBus.closeSession(sessionId);
    }
  }
  return closed;
}
