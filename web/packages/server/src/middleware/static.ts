// Serving the built client (`03-api-and-events.md` §5).
//
// The same process serves the API and the SPA in production; in development
// Vite serves the client and proxies here, so this is skipped when the build
// directory is absent.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../deps.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/** Vite writes hashed assets under `assets/`; those are immutable, the rest is
 * revalidated. */
function cacheControl(path: string): string {
  return path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/** Resolves a URL path inside `root`, or null when it escapes it. */
export function resolveWithinRoot(root: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes("\0")) {
    return null;
  }
  const candidate = resolve(root, `.${normalize(decoded)}`);
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
}

/**
 * Static assets with an SPA fallback: any GET that is not an API, auth,
 * upload, or artifact route and does not match a file is answered with
 * `index.html` so the router owns the URL space.
 */
export function clientStatic(distDirectory: string): MiddlewareHandler<AppEnv> | null {
  const root = resolve(distDirectory);
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) {
    return null;
  }
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return next();
    }
    const path = new URL(c.req.url).pathname;
    const filePath = resolveWithinRoot(root, path);
    if (filePath !== null && path !== "/") {
      const found = await stat(filePath).catch(() => null);
      if (found?.isFile()) {
        const body = await readFile(filePath);
        return c.body(new Uint8Array(body), 200, {
          "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
          "Cache-Control": cacheControl(path),
        });
      }
    }
    const html = await readFile(indexPath, "utf8");
    return c.html(html, 200, { "Cache-Control": "no-cache" });
  };
}
