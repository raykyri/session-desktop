// Boot and shutdown lifecycle (`13-deployment-fly.md` §5; phase 2a).
//
// Startup: validate configuration, write credentials to disk, open (and
// migrate) the database, build the sync server over it and the job runner,
// recover the runs that were running when the last process stopped, start
// the effect worker and housekeeping timers, and listen. Shutdown: stop
// admitting, drain the job runner (its open attempts end `interrupted` and
// are resumed by the next process), close the streams, checkpoint the WAL.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { KeyCipher, auth, closeDatabase, openDatabase } from "@session/db";
import type { JobKind } from "@session/mutators";

import { createApp } from "./app.js";
import { SESSION_STREAM_CHECK_MS, closeEndedSessionStreams } from "./auth/session.js";
import { BACKUP_CHECK_INTERVAL_MS, createDocumentBackupScheduler } from "./backups.js";
import { loadConfig, loadDotenvForDevelopment, type Config } from "./config.js";
import type { ServerDeps } from "./deps.js";
import { createReadiness } from "./health.js";
import { defaultLogger, type Logger } from "./logger.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { fixtureLookup, fixturePageFetch } from "./runs/fixtureProvider.js";
import { createRunsService, type RunsService } from "./runs/service.js";
import { accountHandlers } from "./sync/account.js";
import { createSync } from "./sync/setup.js";
import { StreamRegistry } from "./sync/streams.js";

/**
 * Path to database migrations directory. Specified explicitly because the bundled
 * server inlines `@session/db`, which alters relative path resolution from
 * `import.meta.url`.
 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../db/migrations", import.meta.url));
/** `@session/sync`'s migrations, for the same reason. */
export const SYNC_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../sync/migrations", import.meta.url),
);

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

/** Interval for removing expired sessions and state records. */
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

export {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_DOCUMENTS_SCRIPT,
  DAILY_INTERVAL_MS,
  backupDocuments,
} from "./backups.js";

/** Prunes expired rate limit buckets, user sessions, OAuth states and
 * signup attempts. */
export function sweepExpired(
  deps: Pick<ServerDeps, "db">,
  limiter: RateLimiter,
  logger: Logger,
  at: number = Date.now(),
): void {
  const swept = {
    buckets: limiter.sweep(),
    sessions: auth.deleteExpiredSessions(deps.db),
    oauthStates: auth.deleteExpiredOAuthStates(deps.db),
    signupAttempts: auth.deleteSignupAttemptsBefore(deps.db, at - auth.SIGNUP_ATTEMPT_RETENTION_MS),
  };
  logger.debug(swept, "swept expired state");
}

/** Maximum duration to wait for running tasks to drain before proceeding with shutdown.
 * Ensures sufficient time remains within Fly's 30-second `kill_timeout` for WAL
 * checkpointing and database closing (`13-deployment-fly.md` §5). */
export const SHUTDOWN_DEADLINE_MS = 20_000;

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

/** The server's parts over an open database: the sync server, the job
 * runner (the sync server's `JobRunner`), and the stream registry. */
export function buildDeps(o: {
  config: Config;
  db: ReturnType<typeof openDatabase>;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  runs?: Partial<Parameters<typeof createRunsService>[0]>;
  /** Test only: the sync server's options the suites set. */
  sync?: Pick<
    Parameters<typeof createSync>[0],
    "clock" | "random" | "registry" | "failEffect" | "jobs"
  >;
}): ServerDeps {
  const keys = new KeyCipher(o.config.sync.apiKeyEncryptionKey);
  // the runner is made after the sync server it runs jobs for
  let runner: RunsService | null = null;
  const sync = createSync({
    db: o.db,
    config: o.config,
    keys,
    logger: o.logger,
    online: accountHandlers(o.db),
    jobs: {
      start: (j: { kind: JobKind; id: string }) => runner?.start(j),
      cancel: (r: string) => runner?.cancel(r),
    },
    ...o.sync,
  });
  runner = createRunsService({
    config: o.config,
    db: o.db,
    sync,
    keys,
    logger: o.logger,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...o.runs,
  });
  return {
    config: o.config,
    db: o.db,
    sync,
    keys,
    streams: new StreamRegistry(),
    runs: runner,
    logger: o.logger,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  };
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

  const db = openDatabase(config.databasePath, {
    migrationsFolder: MIGRATIONS_DIRECTORY,
    syncMigrationsFolder: SYNC_MIGRATIONS_DIRECTORY,
  });
  const deps = buildDeps({
    config,
    db,
    logger,
    ...(config.fixtureProviders ? { fetch: fixturePageFetch } : {}),
    // Under fixture providers the tools read the fixture's page rather than
    // the network, so an end-to-end run makes no outbound request at all
    // (`12-testing-linting-ci.md` §3.6).
    ...(config.fixtureProviders ? { runs: { toolOverrides: { lookup: fixtureLookup } } } : {}),
  });
  // boot recovery, then the effect worker, housekeeping and the queue
  deps.runs.recover();
  deps.runs.startTimers();

  const limiter = new RateLimiter();
  const maintenance = setInterval(() => {
    sweepExpired(deps, limiter, logger);
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();
  const backups = createDocumentBackupScheduler(config, logger);
  void backups.check();
  const nightly = setInterval(() => {
    void backups.check();
  }, BACKUP_CHECK_INTERVAL_MS);
  nightly.unref();
  const sessionStreams = setInterval(() => {
    try {
      const closed = closeEndedSessionStreams(deps);
      if (closed > 0) logger.info({ closed }, "ended event streams of ended sessions");
    } catch (error) {
      logger.error({ error }, "the session stream check failed");
    }
  }, SESSION_STREAM_CHECK_MS);
  sessionStreams.unref();

  const readiness = createReadiness("starting");
  const mockups = process.env["SESSION_MOCKUPS_DIR"];
  const app = createApp({
    ...deps,
    limiter,
    readiness,
    ...(mockups ? { mockupsDirectory: mockups } : {}),
  });
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
    readiness.drain();
    clearInterval(maintenance);
    clearInterval(nightly);
    clearInterval(sessionStreams);
    logger.info({ signal }, "shutting down");
    const drained = await drainWithin(() => deps.runs.drain(), SHUTDOWN_DEADLINE_MS);
    if (!drained) {
      logger.warn(
        { signal, deadlineMs: SHUTDOWN_DEADLINE_MS },
        "the drain did not finish inside its deadline; checkpointing anyway",
      );
    }
    deps.streams.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    closeDatabase(db);
    logger.info({ signal, drained }, "shutdown complete");
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));

  return { close: () => shutdown("close") };
}
