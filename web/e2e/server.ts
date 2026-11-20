// The e2e suite's server (phase 2b): `@session/server/test-server` (the
// production assembly over a temp database, with test sign-in, the test
// routes `/api/test/*` and a settable sync clock) on the suite's port,
// serving the built client, with the fixture providers and the job
// runner's timers on. `playwright.config.ts` starts it.
//
// Phase 3: the Desktop app's built frontend is served from a second origin
// (`DESKTOP_ORIGIN`), which the server admits as a desktop origin (CORS for
// bearer requests and the device sign-in calls), as the app's
// `tauri://localhost` is in production.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_ORIGIN, DESKTOP_ORIGIN, DESKTOP_PORT, E2E_PORT } from "./constants.js";

import { startTestServer } from "@session/server/test-server";

const { ready } = startTestServer({
  port: E2E_PORT,
  publicOrigin: APP_ORIGIN,
  settableClock: true,
  timers: true,
  clientDistDirectory: fileURLToPath(new URL("../packages/client/dist/app", import.meta.url)),
  env: {
    SESSION_CURSOR_KEY: Buffer.alloc(32, 7).toString("base64"),
    SESSION_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
    GOOGLE_VERTEX_PROJECT: "session-e2e",
    OPENROUTER_API_KEY: "openrouter-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    SESSION_DESKTOP_ORIGINS: `tauri://localhost,${DESKTOP_ORIGIN}`,
  },
});

const server = await ready;

// the Desktop app's frontend: its files, and index.html for any other path
// (a reload on a deep route), as Tauri's asset protocol answers
const DESKTOP_DIST = fileURLToPath(new URL("../desktop/dist/app", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".map": "application/json",
};
const desktop = createServer((req, res) => {
  void (async () => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", DESKTOP_ORIGIN).pathname));
    const file = path.startsWith("..") ? null : join(DESKTOP_DIST, path);
    let body: Buffer;
    let type = TYPES[".html"];
    try {
      if (!file || path === "/" || !extname(path)) throw new Error("index");
      body = await readFile(file);
      type = TYPES[extname(path)] ?? "application/octet-stream";
    } catch {
      body = await readFile(join(DESKTOP_DIST, "index.html"));
    }
    res.writeHead(200, { "Content-Type": type ?? "text/plain", "Cache-Control": "no-store" });
    res.end(body);
  })().catch(() => {
    res.writeHead(500);
    res.end();
  });
});
desktop.listen(DESKTOP_PORT, "127.0.0.1");

// keep the process alive: the test server unrefs its listener
setInterval(() => undefined, 1 << 30);
process.stdout.write(`e2e server at ${server.origin}; the Desktop app at ${DESKTOP_ORIGIN}\n`);
const stop = () => {
  desktop.close();
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
