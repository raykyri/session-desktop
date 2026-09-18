// Boot and shutdown (`13-deployment-fly.md` §5,
// `05-run-lifecycle-and-streaming.md` §7).
//
// Order matters: the environment is validated before anything opens a file,
// the Vertex credential is on disk before a provider is constructed, and the
// runs interrupted by the previous process are back in the queue before the
// port is listening.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { artifacts, auth, closeDatabase, nodes, openDatabase } from "@session/db";

import { createApp } from "./app.js";
import { loadConfig, loadDotenvForDevelopment, type Config } from "./config.js";
import type { ServerDeps } from "./deps.js";
import { EventBus } from "./events/bus.js";
import { createReadiness } from "./health.js";
import { defaultLogger, type Logger } from "./logger.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { fixtureLookup, fixturePageFetch } from "./runs/fixtureProvider.js";
import { createRunsService } from "./runs/service.js";

/**
 * Writes `GOOGLE_APPLICATION_CREDENTIALS_JSON` to a file and points
 * `GOOGLE_APPLICATION_CREDENTIALS` at it: the Google auth library reads a path,
 * and Fly secrets hold strings (`04-agent-runtime.md` §11).
 */
/**
 * `packages/db/migrations`, passed explicitly rather than taken from
 * `@session/db`'s own default. The server ships as one esbuild bundle at
 * `packages/server/dist/server.mjs`, which inlines the database package, so a
 * path the database module resolves against its own `import.meta.url` would
 * land next to the bundle instead. Both this module and the bundle sit one
 * directory below `packages/server`, so this URL is the same in development,
 * in the test runner, and in the image.
 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../db/migrations", import.meta.url));

export function writeVertexCredentials(config: Config): string | null {
  if (config.vertex.credentialsJson === null) {
    return null;
  }
  mkdirSync(config.tmpDir, { recursive: true });
  const path = join(config.tmpDir, "vertex-credentials.json");
  writeFileSync(path, config.vertex.credentialsJson, { mode: 0o600 });
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = path;
  return path;
}

export function prepareDataDirectories(config: Config): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.documentsDir, { recursive: true });
  mkdirSync(config.tmpDir, { recursive: true });
}

/**
 * Re-queues what the previous process left behind. `reconcileOnBoot` adopts
 * snapshots that landed before the crash, marks orphaned `running` nodes
 * `interrupted`, and puts every `resume_pending` node at the head of the
 * queue; the returned ids are what the agent loop picks up.
 */
export function reconcileRuns(deps: ServerDeps, logger: Logger): void {
  const reconciliation = nodes.reconcileOnBoot(deps.db);
  logger.info(
    {
      adopted: reconciliation.adoptedNodeIds.length,
      interrupted: reconciliation.interruptedNodeIds.length,
      requeued: reconciliation.requeuedNodeIds.length,
    },
    "reconciled runs from the previous process",
  );
  for (const nodeId of reconciliation.requeuedNodeIds) {
    deps.runs.start(nodeId);
  }
}

/** How often the expiries that nothing else reaps are swept. */
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Rows and buckets that expire on their own clock: nothing reads them again,
 * so without this they are kept forever — one rate-limit bucket per address
 * seen, one `sessions` row per sign-in, one `artifact_tokens` row per preview.
 */
export function sweepExpired(deps: ServerDeps, limiter: RateLimiter, logger: Logger): void {
  const swept = {
    buckets: limiter.sweep(),
    sessions: auth.deleteExpiredSessions(deps.db),
    oauthStates: auth.deleteExpiredOAuthStates(deps.db),
    artifactTokens: artifacts.revokeExpired(deps.db),
  };
  logger.debug(swept, "swept expired state");
}

export interface RunningServer {
  close(): Promise<void>;
}

export function main(): RunningServer {
  loadDotenvForDevelopment();
  const config = loadConfig();
  const logger = defaultLogger(config.env);
  prepareDataDirectories(config);
  writeVertexCredentials(config);

  const db = openDatabase(config.databasePath, { migrationsFolder: MIGRATIONS_DIRECTORY });
  const eventBus = new EventBus();
  // The agent loop is constructed before reconciliation so the nodes the last
  // process left behind are picked up by the claim loop as soon as they are
  // back in the queue (`05-run-lifecycle-and-streaming.md` §7).
  const runs = createRunsService({
    config,
    db,
    eventBus,
    logger,
    // Under fixture providers the tools read the fixture's page rather than
    // the network, so an end-to-end run makes no outbound request at all
    // (`12-testing-linting-ci.md` §3.6).
    ...(config.fixtureProviders
      ? { fetch: fixturePageFetch, toolOverrides: { lookup: fixtureLookup } }
      : {}),
  });
  const deps: ServerDeps = { config, db, eventBus, runs, logger };
  reconcileRuns(deps, logger);

  const limiter = new RateLimiter();
  const maintenance = setInterval(() => {
    sweepExpired(deps, limiter, logger);
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();

  // Migrations ran inside `openDatabase` and the previous process's runs are
  // back in the queue, so the only thing left before the check may pass is the
  // listen itself (`13-deployment-fly.md` §5).
  const readiness = createReadiness("starting");
  const app = createApp({ ...deps, limiter, readiness });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    readiness.ready();
    logger.info({ host: config.host, port: info.port }, "session-server listening");
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    // Fails `/healthz` before anything else happens, so Fly stops routing to
    // this machine while the open attempts persist their checkpoints.
    readiness.drain();
    clearInterval(maintenance);
    logger.info({ signal }, "shutting down");
    // Stop admitting first, then let open attempts persist their checkpoint
    // and mark themselves `interrupted` with `resume_pending`.
    await deps.runs.drain();
    deps.eventBus.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    closeDatabase(db);
    logger.info({ signal }, "shutdown complete");
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));

  return { close: () => shutdown("close") };
}
