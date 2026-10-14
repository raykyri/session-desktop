// Image attachments (`research_images`): the owner check and metadata behind
// a `ResearchImageAttachment`, and the lifecycle of the desktop's research
// image store (`src-tauri/src/research_images.rs`). The bytes are on the
// volume, written by the server's upload route through
// `server/src/uploads/storage.ts`.
//
// An uploaded image is pending (`attached_at` null) until a node, a queued
// follow-up or a draft names it. What decides whether an image is still
// needed is whether any message or draft names it, not the column:
// `attached_at` is set when a message or draft is written and corrected by
// the sweep, which also catches references that went away with a cascade
// (a removed thread, branch or workspace). The sweep deletes pending images
// older than `PENDING_IMAGE_LIFETIME_MS`, and returns an image whose last
// reference went away to pending, or deletes it when it is older than that
// lifetime, as the desktop's `release` does. The server then unlinks the
// files no row names.

import type { ResearchImageAttachment, ResearchMessageAttachment } from "@session/shared";
import { MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_IMAGE_BYTES } from "@session/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { researchImages } from "../schema/images.js";
import { now } from "../time.js";

import { treeReadableBy } from "./access.js";

export type ImageRow = typeof researchImages.$inferSelect;

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
 * (`access.treeReadableBy`). An image in a draft is its owner's alone.
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
  const pattern = `%"id":${JSON.stringify(imageId)}%`;
  const named = db.get<{ found: number } | undefined>(sql`
    select 1 as found
      from nodes
      inner join trees on trees.id = nodes.tree_id
      , json_each(nodes.message_json, '$.attachments') as attachment
     where nodes.message_json like ${pattern}
       and json_extract(attachment.value, '$.kind') = 'image'
       and json_extract(attachment.value, '$.id') = ${imageId}
       and ${treeReadableBy(userId)}
    union all
    select 1 as found
      from followup_queue
      inner join trees on trees.id = followup_queue.tree_id
      , json_each(followup_queue.message_json, '$.attachments') as attachment
     where followup_queue.message_json like ${pattern}
       and json_extract(attachment.value, '$.kind') = 'image'
       and json_extract(attachment.value, '$.id') = ${imageId}
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

/** The image ids among a message's or draft's attachments. */
export function imageIdsOf(
  attachments: readonly ResearchMessageAttachment[] | null | undefined,
): string[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.kind === "image" ? [attachment.id] : [],
  );
}

/** Marks images attached once a message or draft naming them is written.
 * Optional for correctness, since the sweep reads the references
 * themselves, but it keeps the column accurate between sweeps. */
export function markAttached(db: SessionDatabase, imageIds: readonly string[], at = now()): void {
  if (imageIds.length === 0) {
    return;
  }
  db.update(researchImages)
    .set({ attachedAt: at })
    .where(inArray(researchImages.id, [...new Set(imageIds)]))
    .run();
}

/**
 * Returns the images among `imageIds` that nothing names any more to
 * pending, after the message, draft or queued follow-up that named them was
 * removed or changed (the desktop's `release`). The sweep then deletes them
 * once they are older than the pending lifetime, which leaves a composer
 * that still holds one a day to send it again. Returns how many were
 * released.
 */
export function release(db: SessionDatabase, imageIds: readonly string[]): number {
  if (imageIds.length === 0) {
    return 0;
  }
  return transact(db, (tx) => {
    const referenced = referencedIds(tx);
    const released = [...new Set(imageIds)].filter((id) => !referenced.has(id));
    if (released.length === 0) {
      return 0;
    }
    return tx
      .update(researchImages)
      .set({ attachedAt: null })
      .where(inArray(researchImages.id, released))
      .run().changes;
  });
}

/** Every image id a node message, a draft or a queued follow-up names. The
 * `like` filters skip rows without an image before their JSON is parsed. */
export function referencedIds(db: SessionDatabase): Set<string> {
  const rows = db.all<{ id: string | null }>(sql`
    select json_extract(attachment.value, '$.id') as id
      from nodes, json_each(nodes.message_json, '$.attachments') as attachment
     where nodes.message_json like '%"kind":"image"%'
       and json_extract(attachment.value, '$.kind') = 'image'
    union
    select json_extract(attachment.value, '$.id') as id
      from research_drafts, json_each(research_drafts.attachments_json) as attachment
     where research_drafts.attachments_json like '%"kind":"image"%'
       and json_extract(attachment.value, '$.kind') = 'image'
    union
    select json_extract(attachment.value, '$.id') as id
      from followup_queue, json_each(followup_queue.message_json, '$.attachments') as attachment
     where followup_queue.message_json like '%"kind":"image"%'
       and json_extract(attachment.value, '$.kind') = 'image'
  `);
  return new Set(rows.flatMap((row) => (row.id === null ? [] : [row.id])));
}

export interface ImageSweepResult {
  /** Rows deleted: pending past their lifetime, or released and older than
   * it. */
  deleted: number;
  /** Attached rows nothing names any more, returned to pending. */
  released: number;
  /** Pending rows a message or draft names, marked attached. */
  attached: number;
}

/**
 * Reconciles `attached_at` with the references and deletes the images that
 * are no longer needed. Files are not touched here: the server unlinks every
 * file under the image directory that no row's `storage_path` names
 * (`storagePaths`), after this runs.
 */
export function sweep(db: SessionDatabase, at: number = now()): ImageSweepResult {
  return transact(db, (tx) => {
    const referenced = referencedIds(tx);
    const expired = at - PENDING_IMAGE_LIFETIME_MS;
    const result: ImageSweepResult = { deleted: 0, released: 0, attached: 0 };
    const toDelete: string[] = [];
    const toRelease: string[] = [];
    const toAttach: string[] = [];
    for (const row of tx
      .select({
        id: researchImages.id,
        createdAt: researchImages.createdAt,
        attachedAt: researchImages.attachedAt,
      })
      .from(researchImages)
      .all()) {
      if (referenced.has(row.id)) {
        if (row.attachedAt === null) toAttach.push(row.id);
      } else if (row.createdAt <= expired) {
        toDelete.push(row.id);
      } else if (row.attachedAt !== null) {
        toRelease.push(row.id);
      }
    }
    for (const ids of chunks(toDelete)) {
      tx.delete(researchImages).where(inArray(researchImages.id, ids)).run();
    }
    for (const ids of chunks(toRelease)) {
      tx.update(researchImages)
        .set({ attachedAt: null })
        .where(inArray(researchImages.id, ids))
        .run();
    }
    for (const ids of chunks(toAttach)) {
      tx.update(researchImages)
        .set({ attachedAt: at })
        .where(inArray(researchImages.id, ids))
        .run();
    }
    result.deleted = toDelete.length;
    result.released = toRelease.length;
    result.attached = toAttach.length;
    return result;
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

/** SQLite caps bound parameters; deletes and updates go in slices. */
function chunks(ids: readonly string[], size = 500): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    result.push(ids.slice(index, index + size));
  }
  return result;
}
