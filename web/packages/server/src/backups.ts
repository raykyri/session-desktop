// The document archive (`13-deployment-fly.md` §6). Litestream replicates
// `session.db` continuously; `/data/documents` (image attachments) is files on
// a volume that nothing else copies, so `web/scripts/backup-documents.sh`
// tars what is new since its last run and ships it to the replica bucket.
//
// The server runs the script itself rather than leaving it to an external
// scheduler, because the deployment is one machine holding one volume: a Fly
// scheduled machine would need the volume this one holds, and an operator-run
// cron is a step that is documented and then not done. A fixed 24-hour timer
// never fires on a machine restarted at least daily (every deploy restarts
// it), so the server checks at boot and then every hour whether the last
// successful run, which the script records by touching its marker file, is a
// day old.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

/** How old the last successful archive may get before the next one runs. */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How often the server checks whether the archive is due. */
export const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** `web/scripts/backup-documents.sh`, resolved the way the migrations
 * directory is: this module and the esbuild bundle both sit one directory
 * below `packages/server`, so the same URL points at `web/scripts` in
 * development and at `/app/scripts` in the image. */
export const BACKUP_DOCUMENTS_SCRIPT = fileURLToPath(
  new URL("../../../scripts/backup-documents.sh", import.meta.url),
);

/** Whether the deployment names somewhere to ship the archive. */
export function documentBackupsConfigured(config: Config): boolean {
  return config.documentsReplicaUrl !== null || config.litestreamReplicaUrl !== null;
}

/** The marker the script touches after every successful run, stamped with
 * the moment its file list was taken (`$SESSION_DATA_DIR/tmp`). */
export function documentsBackupStampPath(config: Config): string {
  return join(config.tmpDir, "documents-backup.stamp");
}

/** Seconds since the last successful archive, or null when there has been
 * none (no marker). */
export function documentsBackupAgeSeconds(config: Config, at = Date.now()): number | null {
  try {
    const stamp = statSync(documentsBackupStampPath(config)).mtimeMs;
    return Math.max(0, Math.floor((at - stamp) / 1000));
  } catch {
    return null;
  }
}

/** Whether the archive should run now: configured, and no successful run in
 * the last `DAILY_INTERVAL_MS`. */
export function documentsBackupDue(config: Config, at = Date.now()): boolean {
  if (!documentBackupsConfigured(config)) {
    return false;
  }
  const age = documentsBackupAgeSeconds(config, at);
  return age === null || age * 1000 >= DAILY_INTERVAL_MS;
}

/**
 * Runs the archive script once. A failure is logged and the next check tries
 * again; the marker advances only on success, so nothing is skipped. A
 * missed archive is not worth refusing to serve over.
 */
export function backupDocuments(config: Config, logger: Logger): Promise<void> {
  if (!documentBackupsConfigured(config)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    execFile(
      BACKUP_DOCUMENTS_SCRIPT,
      {
        // The script finds the volume through `SESSION_DATA_DIR`; the
        // resolved directory is the one this process uses.
        env: { ...process.env, SESSION_DATA_DIR: config.dataDir },
        timeout: 30 * 60 * 1000,
      },
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

/** Runs the archive when it is due, one run at a time. */
export interface DocumentBackupScheduler {
  /** Checks and, when due, runs the archive. Resolves when that is done;
   * a check while a run is in progress does nothing. */
  check(): Promise<void>;
}

export function createDocumentBackupScheduler(
  config: Config,
  logger: Logger,
  run: (config: Config, logger: Logger) => Promise<void> = backupDocuments,
): DocumentBackupScheduler {
  let running: Promise<void> | null = null;
  return {
    check() {
      if (running !== null || !documentsBackupDue(config)) {
        return Promise.resolve();
      }
      running = run(config, logger).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
