// The bytes behind a document row (`03-api-and-events.md` §5,
// `13-deployment-fly.md` §6).
//
// `documents` is metadata; the file lives at
// `${SESSION_DATA_DIR}/documents/<userId>/<sha256>` and nothing in SQLite can
// remove it. Deleting a row without unlinking the file leaks the volume: the
// per-user quota is summed from rows, so an account can delete and re-upload
// for as long as it likes and the 20 GB mount fills until every write fails
// with SQLITE_FULL.
//
// Two paths reach here. The ones that can name what they orphaned — a document
// removed by hand, an account deleted — hand over the paths the repository
// reported. The ones that cannot, because a foreign key cascaded the rows away
// under them (a removed workspace, a removed thread), are caught by the sweep
// below, which is the volume's reconciliation with the table.

import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { documents } from "@session/db";

import type { ServerDeps } from "../deps.js";
import type { Logger } from "../logger.js";

/** A path is unlinked only if it is genuinely inside the documents directory.
 * The column is written by this server and never by a client, but an unlink
 * driven by a database value is worth one comparison. */
export function isInsideDocumentsDir(documentsDir: string, path: string): boolean {
  const root = resolve(documentsDir);
  const target = resolve(path);
  return target.startsWith(`${root}${sep}`);
}

/**
 * Unlinks files whose last row has gone. A missing file is a success: the row
 * and the file are not written in one transaction, so a crash between them is
 * expected and leaves exactly this.
 */
export async function unlinkOrphans(
  documentsDir: string,
  paths: readonly string[],
  logger: Logger,
): Promise<number> {
  let removed = 0;
  for (const path of paths) {
    if (!isInsideDocumentsDir(documentsDir, path)) {
      logger.warn({ path }, "refused to unlink a document outside the documents directory");
      continue;
    }
    try {
      await unlink(path);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error({ path, error }, "could not unlink a document");
      }
    }
  }
  return removed;
}

/** Everything one account stored. Called before `users.removeUser`, whose
 * cascade takes the rows and with them any way of naming the files. */
export async function removeUserDocuments(
  deps: Pick<ServerDeps, "config" | "db">,
  userId: string,
  logger: Logger,
  remove: () => void,
): Promise<number> {
  const paths = documents.storagePathsOf(deps.db, userId);
  remove();
  const unlinked = await unlinkOrphans(deps.config.documentsDir, paths, logger);
  // The per-user directory is content-addressed and nothing else writes into
  // it, so once its rows are gone the directory itself is rubbish too.
  await rm(join(deps.config.documentsDir, userId), { recursive: true, force: true }).catch(
    (error: unknown) => {
      logger.error({ userId, error }, "could not remove a deleted account's document directory");
    },
  );
  return unlinked;
}

export interface OrphanSweep {
  scanned: number;
  removed: number;
  bytes: number;
}

/**
 * Files on the volume that no row points at. This is what catches the deletes
 * nobody could hand a path to: removing a workspace or a thread cascades
 * `documents` rows away inside SQLite, and the bytes would otherwise stay
 * until the machine was rebuilt.
 *
 * Ordered so a file written between the listing and the read of the table is
 * kept rather than deleted: the paths are read from SQLite *after* the
 * directory walk, so a row that landed in between is in the keep set.
 */
export async function sweepOrphanedDocuments(
  deps: Pick<ServerDeps, "config" | "db">,
  logger: Logger,
): Promise<OrphanSweep> {
  const root = deps.config.documentsDir;
  const result: OrphanSweep = { scanned: 0, removed: 0, bytes: 0 };
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ error }, "could not read the documents directory");
    }
    return result;
  }
  const found: string[] = [];
  for (const userId of entries) {
    const directory = join(root, userId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of files) {
      found.push(join(directory, name));
    }
  }
  result.scanned = found.length;
  const keep = documents.allStoragePaths(deps.db);
  for (const path of found) {
    if (keep.has(path)) {
      continue;
    }
    try {
      result.bytes += (await stat(path)).size;
    } catch {
      // Gone already, or unreadable; the unlink below reports what matters.
    }
    result.removed += await unlinkOrphans(root, [path], logger);
  }
  if (result.removed > 0) {
    logger.info({ ...result }, "swept orphaned document bytes");
  }
  return result;
}
