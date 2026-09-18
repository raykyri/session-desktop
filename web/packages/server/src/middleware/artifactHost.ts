// The artifact origin serves artifacts and nothing else
// (`11-artifacts-and-browser.md` §2).
//
// Isolates artifact preview endpoints (/a/:token and /__session/fonts/*) from the main application.
// All other endpoints return 404 on the artifact host to prevent session cookie exposure.

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
