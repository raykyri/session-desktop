// Boot and shutdown lifecycle (`13-deployment-fly.md` §5,
// `05-run-lifecycle-and-streaming.md` §7).
//
// Startup sequence: validate configuration, initialize credentials on disk,
// recover and requeue interrupted runs from previous processes, and begin
// listening on the configured port.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { auth, closeDatabase, nodes, notifications, openDatabase, tweets } from "@session/db";

import { createApp } from "./app.js";
import { SESSION_STREAM_CHECK_MS, closeEndedSessionStreams } from "./auth/session.js";
import { BACKUP_CHECK_INTERVAL_MS, createDocumentBackupScheduler } from "./backups.js";
import { loadConfig, loadDotenvForDevelopment, type Config } from "./config.js";
import type { ServerDeps } from "./deps.js";
import { sweepEmbeds } from "./embeds/storage.js";
import { EventBus } from "./events/bus.js";
import { createReadiness } from "./health.js";
import { TWEET_CACHE_TTL_MS } from "./journal/tweets.js";
import { defaultLogger, type Logger } from "./logger.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { treeDirectory } from "./research/access.js";
import { createDeletionJob } from "./research/deletion.js";
import { dispatchAll } from "./research/followups.js";
import { fixtureLookup, fixturePageFetch } from "./runs/fixtureProvider.js";
import { createRunsService } from "./runs/service.js";
import { sweepImages } from "./uploads/storage.js";

/**
 * Writes Google Cloud service account credentials from configuration to a temporary
 * file and sets `GOOGLE_APPLICATION_CREDENTIALS` for SDK authentication
 * (`04-agent-runtime.md` §11).
 */
/**
 * Path to database migrations directory. Specified explicitly because the bundled
 * server inlines `@session/db`, which alters relative path resolution from
 * `import.meta.url`.
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
 * Re-enqueues incomplete runs from prior processes. `reconcileOnBoot` commits
 * completed snapshots, marks orphaned `running` nodes as `interrupted`, and
 * places `resume_pending` nodes at the front of the queue for the agent loop
 * to resume. Queued follow-ups are then dispatched.
 */
export function reconcileRuns(deps: ServerDeps, logger: Logger): void {
  const reconciliation = nodes.reconcileOnBoot(deps.db);
  logger.info(
    {
      adopted: reconciliation.adoptedNodeIds.length,
      interrupted: reconciliation.interruptedNodeIds.length,
      requeued: reconciliation.requeuedNodeIds.length,
      reenqueued: reconciliation.reenqueuedNodeIds.length,
      stopped: reconciliation.stoppedNodeIds.length,
    },
    "reconciled runs from the previous process",
  );
  if (reconciliation.stoppedNodeIds.length > 0) {
    logger.warn(
      { nodeIds: reconciliation.stoppedNodeIds },
      "stopped runs whose askers can no longer read their threads",
    );
  }
  for (const failure of reconciliation.failures) {
    // Boot sequence continues despite individual run reconciliation failure.
    logger.error(failure, "could not reconcile a run from the previous process");
  }
  for (const nodeId of [...reconciliation.requeuedNodeIds, ...reconciliation.reenqueuedNodeIds]) {
    deps.runs.start(nodeId);
  }
  // Dispatches pending follow-ups queued when previous execution stopped
  // after run completion.
  const sent = dispatchAll({ ...deps, logger });
  if (sent.length > 0) {
    logger.info({ sent: sent.length }, "sent queued follow-ups on boot");
  }
}

/** Interval for removing expired sessions and state records. */
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

/** Interval for pruning unrenewed open-thread presence declarations
 * (`EventBus.expirePresence`). */
const PRESENCE_SWEEP_MS = 15_000;

// The document archive moved to `backups.ts`; these names stay importable
// from here.
export {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_DOCUMENTS_SCRIPT,
  DAILY_INTERVAL_MS,
  backupDocuments,
} from "./backups.js";

/**
 * Prunes expired rate limit buckets, user sessions, OAuth states, cached tweet
 * payloads, signup attempts, and notification records.
 */
export function sweepExpired(
  deps: ServerDeps,
  limiter: RateLimiter,
  logger: Logger,
  at: number = Date.now(),
): void {
  const swept = {
    buckets: limiter.sweep(),
    sessions: auth.deleteExpiredSessions(deps.db),
    oauthStates: auth.deleteExpiredOAuthStates(deps.db),
    // Prunes cached tweet responses older than TTL (`journal/tweets.ts`).
    tweets: tweets.prune(deps.db, at - TWEET_CACHE_TTL_MS),
    signupAttempts: auth.deleteSignupAttemptsBefore(deps.db, at - auth.SIGNUP_ATTEMPT_RETENTION_MS),
    // Read notifications after 30 days, and each inbox beyond its cap.
    notifications: notifications.prune(deps.db, at),
  };
  logger.debug(swept, "swept expired state");
}

/** Executes periodic maintenance tasks: state expiration sweeps, embed asset cache
 * eviction, and unreferenced image cleanup. */
export async function runMaintenance(
  deps: ServerDeps,
  limiter: RateLimiter,
  logger: Logger,
): Promise<void> {
  sweepExpired(deps, limiter, logger);
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
  try {
    await sweepImages(deps, logger);
  } catch (error) {
    logger.error({ error }, "the image sweep failed");
  }
}

/** Maximum duration to wait for running tasks to drain before proceeding with shutdown.
 * Ensures sufficient time remains within Fly's 30-second `kill_timeout` for WAL
 * checkpointing and database closing (`13-deployment-fly.md` §5). */
export const SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * Waits for the drain function up to `deadlineMs`, returning `true` if completed
 * within the deadline. Prevents stalled upstream streams from delaying shutdown
 * beyond the SIGKILL window and blocking WAL checkpoint execution.
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

/**
 * Logs the widget script execution policy during startup. Logs an error if
 * widget scripts are disabled due to shared artifact and application origins
 * (`artifacts/site.ts`).
 */
export function logWidgetScriptPolicy(config: Config, logger: Logger): void {
  if (config.widgetScripts.allowed) {
    logger.info(
      { publicOrigin: config.publicOrigin, artifactOrigin: config.artifactOrigin },
      "widget scripts are enabled: the artifact origin is a separate site",
    );
  } else {
    logger.error(
      { publicOrigin: config.publicOrigin, artifactOrigin: config.artifactOrigin },
      config.widgetScripts.reason ?? "widget scripts are off",
    );
  }
}

export interface RunningServer {
  close(): Promise<void>;
}

export function main(): RunningServer {
  loadDotenvForDevelopment();
  const config = loadConfig();
  const logger = defaultLogger(config.env);
  logWidgetScriptPolicy(config, logger);
  prepareDataDirectories(config);
  writeVertexCredentials(config);

  const db = openDatabase(config.databasePath, { migrationsFolder: MIGRATIONS_DIRECTORY });
  // The bus reads a thread's audience from the database (`research/access.ts`).
  const eventBus = new EventBus(treeDirectory(db));
  const presence = setInterval(() => {
    eventBus.expirePresence();
  }, PRESENCE_SWEEP_MS);
  presence.unref();
  // Creates the runs service prior to reconciliation so recovered nodes are
  // immediately available to the execution claim loop (`05-run-lifecycle-and-streaming.md` §7).
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
  // Fixture providers answer the procedures' own requests (an X post a saved
  // link names) in process too.
  // Deletions background job for items marked by deletion requests or workspace removals.
  const deletions = createDeletionJob({ db, logger });
  const deps: ServerDeps = {
    config,
    db,
    eventBus,
    runs,
    deletions,
    logger,
    ...(config.fixtureProviders ? { fetch: fixturePageFetch } : {}),
  };
  reconcileRuns(deps, logger);
  deletions.kick();

  const limiter = new RateLimiter();
  const maintenance = setInterval(() => {
    void runMaintenance(deps, limiter, logger);
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();
  // Evaluated at startup and hourly so execution proceeds despite frequent process restarts.
  const backups = createDocumentBackupScheduler(config, logger);
  void backups.check();
  const nightly = setInterval(() => {
    void backups.check();
  }, BACKUP_CHECK_INTERVAL_MS);
  nightly.unref();
  // Checks open event streams periodically against their sessions so streams with
  // expired or removed sessions are terminated.
  const sessionStreams = setInterval(() => {
    try {
      const closed = closeEndedSessionStreams(deps);
      if (closed > 0) logger.info({ closed }, "ended event streams of ended sessions");
    } catch (error) {
      logger.error({ error }, "the session stream check failed");
    }
  }, SESSION_STREAM_CHECK_MS);
  sessionStreams.unref();

  // Marks readiness as ready once the HTTP server begins listening
  // (`13-deployment-fly.md` §5).
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
    // Marks readiness as draining so load balancers stop routing traffic while
    // active runs persist checkpoints.
    readiness.drain();
    clearInterval(maintenance);
    clearInterval(nightly);
    clearInterval(presence);
    clearInterval(sessionStreams);
    deletions.stop();
    logger.info({ signal }, "shutting down");
    // Halts admission and allows active runs to persist checkpoints and mark
    // status as interrupted.
    //
    // Enforces a drain deadline to guarantee database close and WAL checkpoint
    // completion before Fly sends SIGKILL (30s after SIGTERM). Any runs interrupted
    // by the deadline are re-enqueued on subsequent startup via `reconcileOnBoot`
    // (`13-deployment-fly.md` §5).
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
