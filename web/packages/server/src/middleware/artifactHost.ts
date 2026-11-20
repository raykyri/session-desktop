// The artifact origin serves widget pages and nothing else
// (`11-artifacts-and-browser.md` §2).
//
// Mounted before every route. On the artifact host only `GET`/`HEAD
// /w/:token` reaches the widget routes; every other method and path is 404,
// so no app route (auth, tRPC, images, the SPA) ever answers there. The
// artifact host never sets a cookie: a `Set-Cookie` header is removed from
// whatever the widget route returns, and the request's own `Cookie` header is
// never read on this host (the session loader is mounted after the widget
// routes).

import type { MiddlewareHandler } from "hono";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

const WIDGET_PATH = /^\/w\/[^/]+$/u;

export function artifactHostOnly(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("host") !== config.artifactHost) {
      await next();
      return;
    }
    const method = c.req.method;
    if ((method !== "GET" && method !== "HEAD") || !WIDGET_PATH.test(c.req.path)) {
      return c.text("not found\n", 404, { "Cache-Control": "no-store" });
    }
    await next();
    c.res.headers.delete("Set-Cookie");
  };
}
