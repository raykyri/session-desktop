// Boot and shutdown lifecycle (`13-deployment-fly.md` §5,
// `05-run-lifecycle-and-streaming.md` §7).
//
// Startup sequence: validate configuration, write credentials to disk, open
// and migrate the database, and begin listening on the configured port.
//
// Runs are not started in this build. The run loop (`runs/loop.ts`) has no
// store until M5a implements `RunStore` over the run records; M5a also adds
// the dispatcher, closes `usage_events` rows left open and marks runs still
// `running` as `interrupted` at boot (plan `01` S5, `03` E2).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { accounts, auth, closeDatabase, openDatabase } from "@session/db";

import { createApp } from "./app.js";
import { BACKUP_CHECK_INTERVAL_MS, createDocumentBackupScheduler } from "./backups.js";
import { loadConfig, loadDotenvForDevelopment, type Config } from "./config.js";
import type { ServerDeps } from "./deps.js";
import { createReadiness } from "./health.js";
import { defaultLogger, type Logger } from "./logger.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { fixturePageFetch } from "./runs/fixtureProvider.js";
import { MemoryLedger } from "./runs/memoryLedger.js";
import { createNoopRunsService } from "./runs/service.js";

/**
 * Path to database migrations directory. Specified explicitly because the bundled
 * server inlines `@session/db`, which alters relative path resolution from
 * `import.meta.url`.
 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../db/migrations", import.meta.url));

/**
 * Writes Google Cloud service account credentials from configuration to a temporary
 * file and sets `GOOGLE_APPLICATION_CREDENTIALS` for SDK authentication
 * (`04-agent-runtime.md` §11).
 */
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

/** Boot logs a warning when stored API keys would be sealed under the
 * public development key (`SESSION_SECRET_KEY` unset; `config.ts`). */
export function warnOnDevelopmentSecretKey(config: Config, logger: Logger): boolean {
  if (!config.secretKeyIsDevelopment) return false;
  logger.warn(
    { env: config.env },
    "SESSION_SECRET_KEY is unset: stored API keys are sealed under the public development key",
  );
  return true;
}

export function prepareDataDirectories(config: Config): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.documentsDir, { recursive: true });
  mkdirSync(config.tmpDir, { recursive: true });
}

/** Interval for removing expired sessions and state records. */
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

// The document archive moved to `backups.ts`; these names stay importable
// from here.
export {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_DOCUMENTS_SCRIPT,
  DAILY_INTERVAL_MS,
  backupDocuments,
} from "./backups.js";

/** Prunes expired rate limit buckets, user sessions, OAuth states and sign-up
 * attempts, and deletes waiting accounts older than 90 days (plan `04`
 * §3.1, decision S4): scheduled maintenance, not a queue. */
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
    signupAttempts: auth.deleteSignupAttemptsBefore(deps.db, at - auth.SIGNUP_ATTEMPT_RETENTION_MS),
    waitingAccounts: accounts.sweepWaiting(deps.db, at),
  };
  logger.debug(swept, "swept expired state");
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

export interface RunningServer {
  close(): Promise<void>;
}

export function main(): RunningServer {
  loadDotenvForDevelopment();
  const config = loadConfig();
  const logger = defaultLogger(config.env);
  warnOnDevelopmentSecretKey(config, logger);
  prepareDataDirectories(config);
  writeVertexCredentials(config);

  const db = openDatabase(config.databasePath, { migrationsFolder: MIGRATIONS_DIRECTORY });
  const deps: ServerDeps = {
    config,
    db,
    // No attempt runs before M5a, so there is nothing to drain yet.
    runs: createNoopRunsService(),
    // `usage.get` and `usage.listRuns` read the ledger (`03` K5). No run
    // starts in this build, so it stays empty until the SQLite ledger and
    // the run store replace it.
    ledger: new MemoryLedger(),
    logger,
    // Under fixture providers outbound requests are answered in process, so
    // an end-to-end run makes no outbound request at all
    // (`12-testing-linting-ci.md` §3.6).
    ...(config.fixtureProviders ? { fetch: fixturePageFetch } : {}),
  };

  const limiter = new RateLimiter();
  const maintenance = setInterval(() => {
    sweepExpired(deps, limiter, logger);
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();
  // Evaluated at startup and hourly so execution proceeds despite frequent process restarts.
  const backups = createDocumentBackupScheduler(config, logger);
  void backups.check();
  const nightly = setInterval(() => {
    void backups.check();
  }, BACKUP_CHECK_INTERVAL_MS);
  nightly.unref();

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
    // Marks readiness as draining so the proxy stops routing new requests.
    readiness.drain();
    clearInterval(maintenance);
    clearInterval(nightly);
    logger.info({ signal }, "shutting down");
    // Enforces a drain deadline to guarantee database close and WAL checkpoint
    // completion before Fly sends SIGKILL (30s after SIGTERM)
    // (`13-deployment-fly.md` §5).
    const drained = await drainWithin(() => deps.runs.drain(), SHUTDOWN_DEADLINE_MS);
    if (!drained) {
      logger.warn(
        { signal, deadlineMs: SHUTDOWN_DEADLINE_MS },
        "the drain did not finish inside its deadline; checkpointing anyway",
      );
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    closeDatabase(db);
    logger.info({ signal, drained }, "shutdown complete");
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));

  return { close: () => shutdown("close") };
}
