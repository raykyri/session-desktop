// Content-addressed files on the volume (`13-deployment-fly.md` §6).
//
// Image attachments (`research_images`, `uploads/route.ts`) are stored here
// since the uploaded-documents feature was removed.
//
// A file is stored at `${SESSION_DATA_DIR}/documents/<userId>/<sha256>` (an
// image's thumbnail beside it as `<sha256>.thumb.jpg`) and its metadata row
// lives in SQLite, which cannot remove the file. Deleting a
// row without unlinking the file leaks the volume: a per-user quota summed
// from rows lets an account delete and re-upload until the mount fills and
// every write fails with SQLITE_FULL.
//
// Two paths reach here. The ones that can name what they orphaned (a file
// removed by hand, an account deleted) hand over the paths the repository
// reported. The ones that cannot, because a foreign key cascaded the rows away
// under them (a removed workspace, a removed thread), are caught by the sweep
// below, which reconciles the volume with the table. The caller supplies the
// paths and the keep set, so this module does not depend on a particular
// table.

import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { images } from "@session/db";

import type { ServerDeps } from "../deps.js";
import type { Logger } from "../logger.js";

import { thumbnailPath } from "./images.js";

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

/** Everything one account stored. `paths` must be read before `remove` runs
 * `users.removeUser`, whose cascade takes the rows and with them any way of
 * naming the files. */
export async function removeUserDocuments(
  deps: Pick<ServerDeps, "config">,
  userId: string,
  paths: readonly string[],
  logger: Logger,
  remove: () => void,
): Promise<number> {
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

/** How long a file no row names is kept after it was last written: longer
 * than any upload takes between writing its file and inserting its row. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface OrphanSweep {
  scanned: number;
  removed: number;
  bytes: number;
}

/**
 * Files on the volume that no row points at. This is what catches the deletes
 * nobody could hand a path to: removing a workspace or a thread cascades rows
 * away inside SQLite, and the bytes would otherwise stay until the machine was
 * rebuilt.
 *
 * Ordered so a file written between the listing and the read of the table is
 * kept rather than deleted: `keep` is called *after* the directory walk, so a
 * row that landed in between is in the keep set. A file modified within
 * `graceMs` is kept too: the upload route writes the file (and its
 * thumbnail, and touches a file it found already stored) before it inserts
 * the row, and a sweep in between must not take the file from under it.
 */
export async function sweepOrphanedDocuments(
  deps: Pick<ServerDeps, "config">,
  keep: () => ReadonlySet<string>,
  logger: Logger,
  options: { at?: number; graceMs?: number } = {},
): Promise<OrphanSweep> {
  const youngerThan = (options.at ?? Date.now()) - (options.graceMs ?? ORPHAN_GRACE_MS);
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
  const kept = keep();
  for (const path of found) {
    if (kept.has(path)) {
      continue;
    }
    let size = 0;
    try {
      const stats = await stat(path);
      if (stats.mtimeMs > youngerThan) {
        continue;
      }
      size = stats.size;
    } catch {
      // Gone already, or unreadable; the unlink below reports what matters.
    }
    const removed = await unlinkOrphans(root, [path], logger);
    result.removed += removed;
    if (removed > 0) result.bytes += size;
  }
  if (result.removed > 0) {
    logger.info({ ...result }, "swept orphaned document bytes");
  }
  return result;
}

export interface ImageSweep extends images.ImageSweepResult {
  files: OrphanSweep;
}

/**
 * The maintenance pass over image attachments: `images.sweep` deletes the
 * rows nothing needs (pending past a day, or released and older than that),
 * then every file under the documents directory that no remaining row names,
 * thumbnails included, is unlinked. A file two rows share stays while either
 * row does.
 */
export async function sweepImages(
  deps: Pick<ServerDeps, "config" | "db">,
  logger: Logger,
  at: number = Date.now(),
): Promise<ImageSweep> {
  const rows = images.sweep(deps.db, at);
  const files = await sweepOrphanedDocuments(
    deps,
    () => {
      const keep = new Set<string>();
      for (const path of images.storagePaths(deps.db)) {
        keep.add(path);
        keep.add(thumbnailPath(path));
      }
      return keep;
    },
    logger,
    { at },
  );
  if (rows.deleted > 0 || rows.released > 0) {
    logger.info({ ...rows }, "swept image attachments");
  }
  return { ...rows, files };
}
