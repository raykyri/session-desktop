// A whole server on a local port over a temp database, for suites outside
// this package that talk HTTP to the real app (phase 2a: replica-proto's
// `ServerFactory` over HTTP, and the mockup on the real server). It is the
// production assembly (`buildDeps`, `createApp`) with test sign-in on and the
// sync server's test options (clock, random source, mutators, failures, a
// job runner) passed through; nothing here is reachable from `main`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { closeDatabase, openDatabase } from "@session/db";
import type { AddressInfo } from "node:net";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { ServerDeps } from "./deps.js";
import { createLogger } from "./logger.js";
import { buildDeps } from "./main.js";

export interface TestServerOptions {
  /** The sync server's test options. */
  sync?: Parameters<typeof buildDeps>[0]["sync"];
  /** More environment (`SESSION_*`). */
  env?: Record<string, string>;
  /** Serve this directory under `/mockups/`. */
  mockupsDirectory?: string;
  /** A fixed port (default: any free one). */
  port?: number;
  /** Start the job runner's timers (effect worker, housekeeping, queue). */
  timers?: boolean;
  /** A sync clock that `POST /api/test/clock` sets (an offset from the real
   * clock), when `sync.clock` is not given. */
  settableClock?: boolean;
}

export interface RunningTestServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  deps: ServerDeps;
  close(): Promise<void>;
}

/** Start a server; resolves once it listens. */
export function startTestServer(o: TestServerOptions = {}): {
  deps: ServerDeps;
  ready: Promise<RunningTestServer>;
} {
  const directory = mkdtempSync(join(tmpdir(), "session-http-"));
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(o.port ?? 0),
    SESSION_PUBLIC_ORIGIN: "http://127.0.0.1:8787",
    SESSION_DATA_DIR: directory,
    SESSION_TEST_AUTH: "1",
    SESSION_FIXTURE_PROVIDERS: "1",
    ...o.env,
  });
  const db = openDatabase(config.databasePath);
  const logger = createLogger({ level: "error", write: () => undefined });
  let offset = 0;
  const clock = o.settableClock ? { now: () => Date.now() + offset } : undefined;
  const built = buildDeps({
    config,
    db,
    logger,
    runs: { autoStart: o.timers === true },
    ...(o.sync || clock ? { sync: { ...(clock ? { clock } : {}), ...o.sync } } : {}),
  });
  const deps = clock
    ? { ...built, testClock: { set: (ms: number) => void (offset = ms - Date.now()) } }
    : built;
  if (o.timers) deps.runs.startTimers();
  const app = createApp({
    ...deps,
    clientDistDirectory: join(directory, "no-client"),
    ...(o.mockupsDirectory ? { mockupsDirectory: o.mockupsDirectory } : {}),
  });
  let server: ServerType | null = null;
  const ready = new Promise<RunningTestServer>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: o.port ?? 0 }, (info) => {
      const port = (info as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        deps,
        close: async () => {
          await deps.runs.drain();
          deps.streams.closeAll();
          await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
          closeDatabase(db);
          rmSync(directory, { recursive: true, force: true });
        },
      });
    });
    // a suite's servers do not keep its process alive
    (server as unknown as { unref?: () => void }).unref?.();
  });
  return { deps, ready };
}
