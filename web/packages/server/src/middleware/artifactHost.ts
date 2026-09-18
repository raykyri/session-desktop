// The artifact origin serves artifacts and nothing else
// (`11-artifacts-and-browser.md` §2).
//
// `artifactRoutes` is mounted ahead of this and answers the two things that
// belong to that host: `/a/:token` and the fonts the rendered page loads.
// Everything after it — the tRPC API, the auth routes, uploads, the SPA — is
// the app. The whole reason the artifact host exists is that the session
// cookie never reaches it, and an auth route answering there is the one thing
// that could make that untrue, so the host is refused wholesale rather than
// route by route: a new route added later is excluded by default.

import type { MiddlewareHandler } from "hono";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

export function artifactHostOnly(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("host") === config.artifactHost) {
      return c.text("not found\n", 404, { "Cache-Control": "no-store" });
    }
    await next();
  };
}
