// Test-only routes (mounted when `SESSION_TEST_AUTH` is on outside
// production, as `POST /auth/test-login` is), so the mockup's `?sync=1`
// mode runs against the real server (phase 2a):
//
//   POST /api/test/records  { records: [{ key, record }] }: each record is
//     written as a server write, in one commit (revs, log rows and the id
//     registry as any write makes them); a record null deletes its key.
//   POST /api/test/device   { login }: an account for the login and a device
//     token for it, signed in through the device calls (authorize, approve,
//     token), for a page that sends bearer requests.
//   POST /api/test/clock    { now }: the sync server's time, when the test
//     server's clock is settable (the mockup's clock is fixed).
//   POST /api/test/fail     { code, times }: the next `times` writes answer
//     `code`, unrecorded, as the mock's DevConfig `failOn` does.
//   GET  /mockups/<file>    the files of `mockupsDirectory`.

import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { users } from "@session/db";
import type { Draft, Write } from "@session/mutators";
import { Hono } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";

import { STATUS } from "./routes.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** The sync tables a fresh scenario empties. */
const FRESH_TABLES = [
  "sync_records",
  "sync_index",
  "sync_registry",
  "sync_log",
  "sync_epochs",
  "sync_tombstones",
  "sync_answers",
  "sync_seq_answers",
  "sync_clients",
  "sync_registrations",
  "sync_effects",
  "sync_dead_letters",
  "sync_leases",
  "sync_device_runs",
];

export function scenarioRoutes(deps: ServerDeps, mockupsDirectory?: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (!deps.config.testAuthEnabled) return app;

  app.post("/api/test/records", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      records?: { key: string; record: Draft | null }[];
      /** Start the sync store over first, as the mock's scenarios go back
       * to the seed: every record, log row, id, recorded answer, client,
       * registration and queued effect is dropped (device tokens stay), and
       * the database gets a new instance id, so no earlier cursor opens. */
      fresh?: boolean;
    } | null;
    if (!body || !Array.isArray(body.records))
      return c.json({ error: "expected { records }" }, 400);
    if (body.fresh) {
      for (const t of FRESH_TABLES) deps.db.$client.prepare(`DELETE FROM ${t}`).run();
      deps.sync.resetInstance();
    }
    const writes = body.records.map((r): Write => [r.key, r.record]);
    const version = deps.sync.run((tx) => deps.sync.commit(tx, writes, deps.sync.time(tx)));
    return c.json({ ok: true, version });
  });

  app.post("/api/test/device", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { login?: string } | null;
    const login = body?.login ?? "";
    if (!login) return c.json({ error: "expected { login }" }, 400);
    const githubId = Number(
      BigInt(`0x${Buffer.from(login, "utf8").toString("hex")}`) % 1000000007n,
    );
    const { user } = users.upsertFromGitHub(deps.db, { githubId, login, name: login });
    const a = deps.sync.call(null, "devices.authorize", { name: `${login}'s Mac` });
    const request = a.ok ? (a.result as { request: string }).request : "";
    const code = a.ok ? (a.result as { code: string }).code : "";
    deps.sync.call({ u: user.handle }, "devices.approve", { request, code });
    const t = deps.sync.call(null, "devices.token", { request });
    if (!t.ok) return c.json({ error: t.error }, 500);
    return c.json({ ...(t.result as object), handle: user.handle });
  });

  app.post("/api/test/clock", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { now?: number } | null;
    if (!deps.testClock || typeof body?.now !== "number")
      return c.json({ error: "no settable clock, or no { now }" }, 400);
    deps.testClock.set(body.now);
    // server time never goes back on its own: the operator's reset
    return c.json({ ok: true, now: deps.sync.resetTime() });
  });

  // the lowest protocol version taken (the mock's DevConfig minProtocol)
  app.post("/api/test/config", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { minProtocol?: number } | null;
    if (typeof body?.minProtocol !== "number")
      return c.json({ error: "expected { minProtocol }" }, 400);
    (deps.sync as unknown as { minProtocol: number }).minProtocol = body.minProtocol;
    return c.json({ ok: true });
  });

  let fail: { code: string; times: number } | null = null;
  app.post("/api/test/fail", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { code?: string; times?: number } | null;
    fail = body?.code ? { code: body.code, times: body.times ?? 1 } : null;
    return c.json({ ok: true });
  });
  app.use("/api/sync/write", async (c, next) => {
    if (!fail || fail.times <= 0) return next();
    fail.times--;
    const code = fail.code;
    return c.json(
      { ok: false, error: { code, message: code }, serverTime: deps.sync.clockNow() },
      (STATUS[code] ?? 500) as 500,
    );
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
