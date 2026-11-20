// Image references (`image_refs`): which node, draft or queued follow-up
// names which image (`repos/images.ts` has the lifecycle). Kept apart from
// `images.ts` so the modules that delete nodes (`subtrees.ts`) can drop
// references without importing the access rules `images.readable` needs.

import type { ResearchMessageAttachment } from "@session/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import type { ImageHolderKind } from "../schema/images.js";
import { imageRefs, researchImages } from "../schema/images.js";
import { now } from "../time.js";

export type ImageRefRow = typeof imageRefs.$inferSelect;

/** The image ids among a message's or draft's attachments. */
export function imageIdsOf(
  attachments: readonly ResearchMessageAttachment[] | null | undefined,
): string[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.kind === "image" ? [attachment.id] : [],
  );
}

/** Marks images attached. `setRefs` does this for what it references; the
 * sweep corrects the column for anything else. */
export function markAttached(db: SessionDatabase, imageIds: readonly string[], at = now()): void {
  if (imageIds.length === 0) {
    return;
  }
  for (const ids of chunks([...new Set(imageIds)])) {
    db.update(researchImages).set({ attachedAt: at }).where(inArray(researchImages.id, ids)).run();
  }
}

/** A node, draft or queued follow-up that names images. */
export interface ImageHolder {
  kind: ImageHolderKind;
  id: string;
  /** The thread of a node or queued item; null for a draft. */
  treeId: string | null;
}

/**
 * Makes the references of `holder` exactly the images among `attachments`,
 * inside the caller's transaction: references to images no longer named are
 * dropped (and those images released when nothing else names them), new
 * ones are written, and the named images are marked attached. An id with no
 * image row (deleted since it was resolved) is skipped.
 */
export function setRefs(
  db: SessionDatabase,
  holder: ImageHolder,
  attachments: readonly ResearchMessageAttachment[] | null | undefined,
  at: number = now(),
): void {
  const named = [...new Set(imageIdsOf(attachments))];
  const previous = db
    .select({ imageId: imageRefs.imageId })
    .from(imageRefs)
    .where(and(eq(imageRefs.holderKind, holder.kind), eq(imageRefs.holderId, holder.id)))
    .all()
    .map((row) => row.imageId);
  const gone = previous.filter((id) => !named.includes(id));
  if (gone.length > 0) {
    db.delete(imageRefs)
      .where(
        and(
          eq(imageRefs.holderKind, holder.kind),
          eq(imageRefs.holderId, holder.id),
          inArray(imageRefs.imageId, gone),
        ),
      )
      .run();
  }
  if (named.length > 0) {
    const existing = new Set(
      db
        .select({ id: researchImages.id })
        .from(researchImages)
        .where(inArray(researchImages.id, named))
        .all()
        .map((row) => row.id),
    );
    const values = named
      .filter((id) => existing.has(id))
      .map((imageId) => ({
        imageId,
        holderKind: holder.kind,
        holderId: holder.id,
        treeId: holder.treeId,
        createdAt: at,
      }));
    if (values.length > 0) {
      db.insert(imageRefs).values(values).onConflictDoNothing().run();
      markAttached(
        db,
        values.map((value) => value.imageId),
        at,
      );
    }
  }
  releaseUnreferenced(db, gone);
}

/**
 * Drops the references of the given holders, inside the caller's
 * transaction, and releases the images nothing else names. Returns the
 * released image ids.
 */
export function dropRefs(
  db: SessionDatabase,
  kind: ImageHolderKind,
  holderIds: readonly string[],
): string[] {
  const affected = new Set<string>();
  for (const ids of chunks([...new Set(holderIds)])) {
    for (const row of db
      .delete(imageRefs)
      .where(and(eq(imageRefs.holderKind, kind), inArray(imageRefs.holderId, ids)))
      .returning({ imageId: imageRefs.imageId })
      .all()) {
      affected.add(row.imageId);
    }
  }
  return releaseUnreferenced(db, [...affected]);
}

/**
 * Drops the references of nodes about to be deleted, and of the queued
 * follow-ups that go with them (a queued item cascades with its chain's
 * head), inside the caller's transaction. Every path that deletes nodes
 * calls this first (`subtrees.ts`).
 */
export function dropNodeRefs(db: SessionDatabase, nodeIds: readonly string[]): string[] {
  if (nodeIds.length === 0) {
    return [];
  }
  const queued: string[] = [];
  for (const ids of chunks([...new Set(nodeIds)])) {
    queued.push(
      ...db
        .all<{ id: string }>(
          sql`
        select id from followup_queue
         where head_node_id in (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
      `,
        )
        .map((row) => row.id),
    );
  }
  return [...new Set([...dropRefs(db, "node", nodeIds), ...dropRefs(db, "queue", queued)])];
}

/** The references one holder has, for tests and the agent loop. */
export function refsOf(
  db: SessionDatabase,
  kind: ImageHolderKind,
  holderId: string,
): ImageRefRow[] {
  return db
    .select()
    .from(imageRefs)
    .where(and(eq(imageRefs.holderKind, kind), eq(imageRefs.holderId, holderId)))
    .orderBy(imageRefs.imageId)
    .all();
}

/**
 * Returns the images among `imageIds` that nothing names any more to
 * pending (the desktop's `release`). The sweep then deletes them once they
 * are older than the pending lifetime, which leaves a composer that still
 * holds one a day to send it again. Returns how many were released.
 */
export function release(db: SessionDatabase, imageIds: readonly string[]): number {
  if (imageIds.length === 0) {
    return 0;
  }
  return transact(db, (tx) => releaseUnreferenced(tx, imageIds).length);
}

/** `release` inside the caller's transaction, returning the ids released. */
function releaseUnreferenced(db: SessionDatabase, imageIds: readonly string[]): string[] {
  const released: string[] = [];
  for (const ids of chunks([...new Set(imageIds)])) {
    released.push(
      ...db
        .update(researchImages)
        .set({ attachedAt: null })
        .where(
          and(
            inArray(researchImages.id, ids),
            sql`${researchImages.attachedAt} is not null`,
            sql`not exists (select 1 from ${imageRefs} where ${imageRefs.imageId} = ${researchImages.id})`,
          ),
        )
        .returning({ id: researchImages.id })
        .all()
        .map((row) => row.id),
    );
  }
  return released;
}

/** SQLite caps bound parameters; deletes and updates go in slices. */
function chunks(ids: readonly string[], size = 500): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    result.push(ids.slice(index, index + size));
  }
  return result;
}
