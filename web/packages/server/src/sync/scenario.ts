// Test-only routes (mounted when `SESSION_TEST_AUTH` is on outside
// production, as `POST /auth/test-login` is): load a scenario's records into
// the sync store, and serve the mockup's files from the same origin, so the
// mockup's `?sync=1` mode runs against the real server (phase 2a).
//
//   POST /api/test/records  { records: [{ key, record }] }: each record is
//     written as a server write, in one commit (revs, log rows and the id
//     registry as any write makes them); a record null deletes its key.
//   GET  /mockups/<file>    the files of `mockupsDirectory`.

import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import type { Draft, Write } from "@session/mutators";
import { Hono } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function scenarioRoutes(deps: ServerDeps, mockupsDirectory?: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (!deps.config.testAuthEnabled) return app;

  app.post("/api/test/records", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      records?: { key: string; record: Draft | null }[];
    } | null;
    if (!body || !Array.isArray(body.records)) return c.json({ error: "expected { records }" }, 400);
    const writes = body.records.map((r): Write => [r.key, r.record]);
    const version = deps.sync.run((tx) => deps.sync.commit(tx, writes, deps.sync.time(tx)));
    return c.json({ ok: true, version });
  });

  if (mockupsDirectory !== undefined) {
    app.get("/mockups/*", async (c) => {
      const rel = normalize(decodeURIComponent(c.req.path.slice("/mockups/".length)));
      if (rel.startsWith("..") || rel.includes("\0")) return c.notFound();
      try {
        const bytes = await readFile(join(mockupsDirectory, rel));
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": TYPES[extname(rel)] ?? "application/octet-stream",
            "Cache-Control": "no-store",
            // the mockup is one page with inline scripts and styles
            "Content-Security-Policy":
              "default-src 'self' 'unsafe-inline' data: blob:; img-src * data: blob:",
          },
        });
      } catch {
        return c.notFound();
      }
    });
  }
  return app;
}
