// Boot and shutdown (`13-deployment-fly.md` §5,
// `05-run-lifecycle-and-streaming.md` §7).
//
// Order matters: the environment is validated before anything opens a file,
// the Vertex credential is on disk before a provider is constructed, and the
// runs interrupted by the previous process are back in the queue before the
// port is listening.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { artifacts, auth, closeDatabase, nodes, openDatabase } from "@session/db";

import { createApp } from "./app.js";
import { loadConfig, loadDotenvForDevelopment, type Config } from "./config.js";
import type { ServerDeps } from "./deps.js";
import { sweepEmbeds } from "./embeds/storage.js";
import { EventBus } from "./events/bus.js";
import { createReadiness } from "./health.js";
import { defaultLogger, type Logger } from "./logger.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { fixtureLookup, fixturePageFetch } from "./runs/fixtureProvider.js";
import { createRunsService } from "./runs/service.js";
import { sweepOrphanedDocuments } from "./uploads/storage.js";

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
  mkdirSync(config.embedsDir, { recursive: true });
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
      reenqueued: reconciliation.reenqueuedNodeIds.length,
      emptyDocuments: reconciliation.emptyDocumentNodeIds.length,
    },
    "reconciled runs from the previous process",
  );
  for (const nodeId of [...reconciliation.requeuedNodeIds, ...reconciliation.reenqueuedNodeIds]) {
    deps.runs.start(nodeId);
  }
}

/** Interval for removing expired sessions and state records. */
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

/** How often the document archive is shipped and the volume is reconciled
 * with the `documents` table (`13-deployment-fly.md` §6). */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** `web/scripts/backup-documents.sh`, resolved the way the migrations
 * directory is: this module and the esbuild bundle both sit one directory
 * below `packages/server`, so the same URL points at `web/scripts` in
 * development and at `/app/scripts` in the image. */
export const BACKUP_DOCUMENTS_SCRIPT = fileURLToPath(
  new URL("../../../scripts/backup-documents.sh", import.meta.url),
);

/**
 * The nightly document archive. Litestream replicates `session.db`
 * continuously; `/data/documents` is files on a volume that nothing else
 * copies, so losing the volume would lose every uploaded file.
 *
 * Run in process rather than from an external scheduler because the
 * deployment is one machine with one process: a Fly scheduled machine would
 * need the volume this one holds, and an operator-run cron is a step that is
 * documented and then not done. A failure is logged and the next day tries
 * again — a missed archive is not worth refusing to serve over.
 */
export function backupDocuments(config: Config, logger: Logger): Promise<void> {
  if (config.documentsReplicaUrl === null && config.litestreamReplicaUrl === null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    execFile(
      BACKUP_DOCUMENTS_SCRIPT,
      { env: process.env, timeout: 30 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          logger.error({ error, stderr: String(stderr).slice(0, 2000) }, "document backup failed");
        } else {
          logger.info({ output: String(stdout).trim().slice(0, 2000) }, "document backup complete");
        }
        resolve();
      },
    );
  });
}

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

/**
 * One maintenance tick: the expiries above, plus the volume's reconciliation
 * with the `documents` table. The sweep is what catches the deletes no caller
 * could hand a path to — removing a workspace or a thread cascades the rows
 * away inside SQLite and leaves the bytes — without which the mount fills and
 * every SQLite write fails at once.
 */
export async function runMaintenance(
  deps: ServerDeps,
  limiter: RateLimiter,
  logger: Logger,
): Promise<void> {
  sweepExpired(deps, limiter, logger);
  try {
    await sweepOrphanedDocuments(deps, logger);
  } catch (error) {
    logger.error({ error }, "the document sweep failed");
  }
  try {
    const swept = await sweepEmbeds({
      db: deps.db,
      embedsDir: deps.config.embedsDir,
      fetch: deps.fetch ?? globalThis.fetch,
      logger,
      maxBytes: deps.config.embedCacheBytes,
    });
    if (swept.evicted > 0 || swept.prunedRows > 0) {
      logger.info({ ...swept }, "swept the embed asset cache");
    }
  } catch (error) {
    logger.error({ error }, "the embed sweep failed");
  }
}

/** How long the drain is given before the process stops waiting for it. Fly's
 * `kill_timeout` is 30s and SIGKILL follows it, so the deadline is short
 * enough that the WAL checkpoint and the close still fit inside the budget
 * (`13-deployment-fly.md` §5). */
export const SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * The drain, raced against its deadline. `true` when it finished on its own.
 *
 * Awaiting the drain outright is what makes `kill_timeout` a SIGKILL: a
 * provider that has stopped sending without closing its stream holds it open
 * past thirty seconds, the WAL checkpoint below never runs, and the next boot
 * opens a database with an unclean log. What the deadline cuts short is
 * recovered on boot — `reconcileOnBoot` marks anything still `running` as
 * `interrupted` with `resume_pending` and re-queues it — so a drain that runs
 * long costs a resume, while a SIGKILL costs the checkpoint.
 */
export async function drainWithin(
  drain: () => Promise<void>,
  deadlineMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      drain().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
    void runMaintenance(deps, limiter, logger);
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();
  const nightly = setInterval(() => {
    void backupDocuments(config, logger);
  }, DAILY_INTERVAL_MS);
  nightly.unref();

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
    clearInterval(nightly);
    logger.info({ signal }, "shutting down");
    // Stop admitting first, then let open attempts persist their checkpoint
    // and mark themselves `interrupted` with `resume_pending`.
    //
    // Raced against a deadline rather than awaited outright. Fly sends SIGKILL
    // `kill_timeout` (30s) after SIGTERM, and a provider that has stopped
    // sending without closing its stream would hold the drain past it — the
    // WAL checkpoint below would then never run and the next boot would open a
    // database with an unclean log. Twenty seconds leaves ten for the close
    // and the checkpoint. What the deadline cuts short is recovered on boot:
    // `reconcileOnBoot` marks anything still `running` as `interrupted` with
    // `resume_pending` and re-queues it (`13-deployment-fly.md` §5).
    const drained = await drainWithin(() => deps.runs.drain(), SHUTDOWN_DEADLINE_MS);
    if (!drained) {
      logger.warn(
        { signal, deadlineMs: SHUTDOWN_DEADLINE_MS },
        "the drain did not finish inside its deadline; checkpointing anyway",
      );
    }
    deps.eventBus.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    closeDatabase(db);
    logger.info({ signal, drained }, "shutdown complete");
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));

  return { close: () => shutdown("close") };
}
