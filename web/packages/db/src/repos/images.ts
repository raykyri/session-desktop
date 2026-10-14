// Image attachments (`research_images`): the owner check and metadata behind
// a `ResearchImageAttachment`, and the lifecycle of the desktop's research
// image store (`src-tauri/src/research_images.rs`). The bytes are on the
// volume, written by the server's upload route through
// `server/src/uploads/storage.ts`.
//
// An uploaded image is pending (`attached_at` null) until a node, a queued
// follow-up or a draft names it. What names an image is `image_refs`: one
// row per (image, holder), written by the repositories in the same
// transaction as the message, draft or queued item (`setRefs`), and deleted
// with it (`dropRefs`, `dropNodeRefs`). Writing a reference marks the image
// attached; dropping the last one returns it to pending, as the desktop's
// `release` does. The sweep deletes pending images older than
// `PENDING_IMAGE_LIFETIME_MS`, drops references whose holder is gone, and
// corrects `attached_at`. The server then unlinks the files no row names.

import type { ResearchImageAttachment } from "@session/shared";
import { MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_IMAGE_BYTES } from "@session/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import type { ImageHolderKind } from "../schema/images.js";
import { imageRefs, researchImages } from "../schema/images.js";
import { now } from "../time.js";

import { treeReadableBy } from "./access.js";

export type ImageRow = typeof researchImages.$inferSelect;
export type { ImageHolderKind };

/** How long an image nothing names is kept for a composer, draft editor or
 * queue that may still send it (`PENDING_LIFETIME`). */
export const PENDING_IMAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The desktop's message for an image that is gone or was never this
 * account's. One message for both, so an id is not an existence oracle. */
export const IMAGE_UNAVAILABLE =
  "An attached image is no longer available. Remove it and attach it again.";

export interface NewImage {
  sha256: string;
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  fileName: string | null;
  storagePath: string;
}

/** Records an upload. The image is pending until a message or draft names
 * it. */
export function create(
  db: SessionDatabase,
  userId: string,
  input: NewImage,
  id: string = newId(),
): ImageRow {
  return db
    .insert(researchImages)
    .values({ id, ownerId: userId, ...input, createdAt: now(), attachedAt: null })
    .returning()
    .get();
}

/** The image if `userId` owns it. */
export function get(db: SessionDatabase, userId: string, imageId: string): ImageRow | null {
  return (
    db
      .select()
      .from(researchImages)
      .where(and(eq(researchImages.ownerId, userId), eq(researchImages.id, imageId)))
      .get() ?? null
  );
}

/**
 * The image if `userId` (null: a guest) may see it: they uploaded it, or a
 * node or queued follow-up of a thread they may read names it
 * (`access.treeReadableBy`, through `image_refs.tree_id`). An image in a
 * draft is its owner's alone.
 */
export function readable(
  db: SessionDatabase,
  userId: string | null,
  imageId: string,
): ImageRow | null {
  const row = findById(db, imageId);
  if (!row) {
    return null;
  }
  if (userId !== null && row.ownerId === userId) {
    return row;
  }
  const named = db.get<{ found: number } | undefined>(sql`
    select 1 as found
      from ${imageRefs}
      inner join trees on trees.id = ${imageRefs.treeId}
     where ${imageRefs.imageId} = ${imageId}
       and ${imageRefs.holderKind} in ('node', 'queue')
       and ${treeReadableBy(userId)}
     limit 1
  `);
  return named ? row : null;
}

/** The image whoever owns it, for a reader that already holds a message
 * naming it (the agent loop). Access was checked when the message was
 * written. */
export function findById(db: SessionDatabase, imageId: string): ImageRow | null {
  return db.select().from(researchImages).where(eq(researchImages.id, imageId)).get() ?? null;
}

/** The attachment a message carries for an image row. */
export function toAttachment(row: ImageRow): ResearchImageAttachment {
  return {
    kind: "image",
    id: row.id,
    mimeType: row.mime,
    byteSize: row.byteSize,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    ...(row.fileName === null ? {} : { fileName: row.fileName }),
  };
}

/** Bytes of image rows `userId` owns, for the upload quota. Rows that share a
 * file count once each, which errs on the side of refusing. */
export function storedBytes(db: SessionDatabase, userId: string): number {
  return (
    db
      .select({ total: sql<number | null>`sum(${researchImages.byteSize})` })
      .from(researchImages)
      .where(eq(researchImages.ownerId, userId))
      .get()?.total ?? 0
  );
}

/**
 * The attachments for the images a message or draft names, in the order
 * given, duplicates dropped (`attachments_for_inputs`). Every image must be
 * `userId`'s; the count and the total size are capped as on the desktop.
 */
export function resolveAttachments(
  db: SessionDatabase,
  userId: string,
  imageIds: readonly string[],
): ResearchImageAttachment[] {
  const ids = [...new Set(imageIds)];
  if (ids.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`A message can include up to ${MAX_IMAGES_PER_MESSAGE} images.`);
  }
  if (ids.length === 0) {
    return [];
  }
  const rows = new Map(
    db
      .select()
      .from(researchImages)
      .where(and(eq(researchImages.ownerId, userId), inArray(researchImages.id, ids)))
      .all()
      .map((row) => [row.id, row]),
  );
  const attachments = ids.map((id) => {
    const row = rows.get(id);
    if (!row) {
      throw new Error(IMAGE_UNAVAILABLE);
    }
    return toAttachment(row);
  });
  const total = attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0);
  if (total > MAX_MESSAGE_IMAGE_BYTES) {
    throw new Error(
      `A message's images can total ${MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)} MB at most.`,
    );
  }
  return attachments;
}

// The references themselves are written by `imageRefs.ts`, which the
// repositories that delete nodes import without this module's access
// dependency.
export {
  dropNodeRefs,
  dropRefs,
  imageIdsOf,
  markAttached,
  refsOf,
  release,
  setRefs,
} from "./imageRefs.js";
export type { ImageHolder, ImageRefRow } from "./imageRefs.js";

export interface ImageSweepResult {
  /** Rows deleted: pending past their lifetime, or released and older than
   * it. */
  deleted: number;
  /** Attached rows nothing names any more, returned to pending. */
  released: number;
  /** Pending rows a message or draft names, marked attached. */
  attached: number;
  /** References whose node, draft or queued item no longer exists (one a
   * foreign-key cascade removed without the repositories), dropped. */
  dangling: number;
}

/**
 * Drops references whose holder is gone, reconciles `attached_at` with the
 * references and deletes the images that are no longer needed. Every step
 * is an indexed lookup per row; no message is parsed. Files are not touched
 * here: the server unlinks every file under the image directory that no
 * row's `storage_path` names (`storagePaths`), after this runs.
 */
export function sweep(db: SessionDatabase, at: number = now()): ImageSweepResult {
  return transact(db, (tx) => {
    const dangling = tx.run(sql`
      delete from ${imageRefs}
       where (${imageRefs.holderKind} = 'node'
              and not exists (select 1 from nodes where nodes.id = ${imageRefs.holderId}))
          or (${imageRefs.holderKind} = 'draft'
              and not exists (select 1 from research_drafts where research_drafts.id = ${imageRefs.holderId}))
          or (${imageRefs.holderKind} = 'queue'
              and not exists (select 1 from followup_queue where followup_queue.id = ${imageRefs.holderId}))
    `).changes;
    const unreferenced = sql`not exists (select 1 from ${imageRefs} where ${imageRefs.imageId} = ${researchImages.id})`;
    const expired = at - PENDING_IMAGE_LIFETIME_MS;
    const deleted = tx
      .delete(researchImages)
      .where(and(sql`${researchImages.createdAt} <= ${expired}`, unreferenced))
      .run().changes;
    const released = tx
      .update(researchImages)
      .set({ attachedAt: null })
      .where(and(sql`${researchImages.attachedAt} is not null`, unreferenced))
      .run().changes;
    const attached = tx
      .update(researchImages)
      .set({ attachedAt: at })
      .where(
        and(
          sql`${researchImages.attachedAt} is null`,
          sql`exists (select 1 from ${imageRefs} where ${imageRefs.imageId} = ${researchImages.id})`,
        ),
      )
      .run().changes;
    return { deleted, released, attached, dangling };
  });
}

/** Every file path a row names. */
export function storagePaths(db: SessionDatabase): string[] {
  return db
    .selectDistinct({ path: researchImages.storagePath })
    .from(researchImages)
    .all()
    .map((row) => row.path);
}
