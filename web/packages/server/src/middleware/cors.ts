// CORS for the desktop app (phase 2a; AGENTS.md: "a CORS allowlist admits the
// desktop origin only"). The desktop's web view has its own origin (Tauri's
// `tauri://localhost` on macOS, configured as `SESSION_DESKTOP_ORIGINS`) and
// authenticates with a bearer device token, never a cookie:
// - a preflight from an allowed origin is answered for the API paths, with
//   the headers the sync transport sends (Authorization, Content-Type, the
//   protocol header, Last-Event-ID);
// - a request from an allowed origin gets `Access-Control-Allow-Origin` only
//   when it carries a bearer token, so a cookie request from that origin is
//   not readable there (and the CSRF guard refuses its writes);
// - no credentials mode: the cookie never crosses;
// - the app's sign-in (phase 3): `devices.authorize` and `devices.token`
//   are called before the app has a token, so they are readable from an
//   allowed origin without one (`DEVICE_SIGNIN`); the CSRF guard lets them
//   through only without a cookie (`csrf.ts`).
// Any other origin gets no CORS headers at all.

import type { MiddlewareHandler } from "hono";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

const API = /^\/(api|auth)\//;

/** The online calls of a device sign-in: the app has no token yet. */
export const DEVICE_SIGNIN: ReadonlySet<string> = new Set([
  "/api/rpc/devices.authorize",
  "/api/rpc/devices.token",
]);

const ALLOW_HEADERS = "Authorization, Content-Type, X-Session-Protocol, Last-Event-ID";

export function desktopCors(config: Config): MiddlewareHandler<AppEnv> {
  const allowed = new Set(config.sync.desktopOrigins);
  return async (c, next) => {
    const origin = c.req.header("origin");
    const path = new URL(c.req.url).pathname;
    if (origin === undefined || !allowed.has(origin) || !API.test(path)) return next();
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
    }
    await next();
    const signin = DEVICE_SIGNIN.has(path) && c.req.header("cookie") === undefined;
    if (signin || /^Bearer /i.test(c.req.header("authorization") ?? "")) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Expose-Headers", "X-Session-Server-Time");
      c.res.headers.append("Vary", "Origin");
    }
  };
}
