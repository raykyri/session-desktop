// The session cookie and the middleware that turns it into `ctx.user`
// (`06-auth-and-users.md` §1, §4).

import { createHmac, randomBytes } from "node:crypto";

import { auth, users } from "@session/db";
import type { User } from "@session/shared";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { Config } from "../config.js";
import type { AppEnv, ServerDeps } from "../deps.js";

export const SESSION_COOKIE = "session";

/** 30 days, matching the idle expiry the `sessions` row enforces. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function setSessionCookie(c: Context<AppEnv>, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Plain `http://localhost` in development would drop a `Secure` cookie.
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
 * Salted so the `signup_attempts` table holds no addresses. The salt has to be
 * secret: the IPv4 space is small enough to enumerate against an unsalted or
 * publicly-salted digest. The OAuth client secret is the one per-deployment
 * secret every sign-in path already requires; a deployment without it cannot
 * sign anyone in through GitHub, so the random fallback only has to be
 * unguessable, not stable.
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

/** Loads the signed-in user onto the request. Never rejects: the tRPC
 * `protectedProcedure` and each route decide what an anonymous request means. */
export function sessionLoader(deps: ServerDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = sessionCookieFrom(c);
    c.set("sessionToken", token);
    c.set("user", userForToken(deps, token));
    await next();
  };
}
