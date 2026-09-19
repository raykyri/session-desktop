// The embed asset cache behind tweet media
// (`docs/02-domain-model-and-database.md` §3.5).
//
// A row is registered when a snapshot is normalized, long before anything is
// fetched: hydration rewrites each remote image URL to `/embeds/<hash>`, and
// the bytes arrive only if a reader ever renders that card. The row therefore
// has two lives — the mapping, which is permanent enough to re-fetch from, and
// the file, which the sweep may take back whenever the volume needs the room.

import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { embedAssets } from "../schema/embeds.js";
import { now } from "../time.js";

export interface EmbedAsset {
  hash: string;
  sourceUrl: string;
  contentType: string | null;
  bytes: number;
  storedAt: number | null;
  lastAccessAt: number;
  createdAt: number;
}

export function get(db: SessionDatabase, hash: string): EmbedAsset | null {
  return db.select().from(embedAssets).where(eq(embedAssets.hash, hash)).get() ?? null;
}

/**
 * Records the mapping from `hash` to `sourceUrl`, keeping whatever bytes the
 * row already has. Re-registering the same image is the common case — a
 * profile picture repeats across every post by one author — and must not drop
 * a stored file on the floor.
 */
export function register(
  db: SessionDatabase,
  input: { hash: string; sourceUrl: string },
  at: number = now(),
): void {
  db.insert(embedAssets)
    .values({
      hash: input.hash,
      sourceUrl: input.sourceUrl,
      contentType: null,
      bytes: 0,
      storedAt: null,
      lastAccessAt: at,
      createdAt: at,
    })
    // `source_url` is what the hash is taken over, so a conflict means the
    // same URL: only the access time is worth moving forward.
    .onConflictDoUpdate({ target: embedAssets.hash, set: { lastAccessAt: at } })
    .run();
}

/** Marks the bytes as present on the volume after a successful fetch. */
export function markStored(
  db: SessionDatabase,
  hash: string,
  input: { contentType: string; bytes: number },
  at: number = now(),
): void {
  db.update(embedAssets)
    .set({
      contentType: input.contentType,
      bytes: input.bytes,
      storedAt: at,
      lastAccessAt: at,
    })
    .where(eq(embedAssets.hash, hash))
    .run();
}

/** Moves an asset's access time forward. Called from the read path, so the
 * caller decides how coarse it wants to be about writing on a read. */
export function touch(db: SessionDatabase, hash: string, at: number = now()): void {
  db.update(embedAssets).set({ lastAccessAt: at }).where(eq(embedAssets.hash, hash)).run();
}

/** Bytes currently on the volume. */
export function storedBytes(db: SessionDatabase): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${embedAssets.bytes}), 0)` })
    .from(embedAssets)
    .where(isNotNull(embedAssets.storedAt))
    .get();
  return row?.total ?? 0;
}

/**
 * Stored assets in eviction order, least recently served first. The sweep
 * walks this list until it has freed what it needs, so the whole set is
 * returned rather than a page: it is one row per cached image, and the bytes
 * are the resource under pressure, not the rows.
 */
export function evictionOrder(db: SessionDatabase): EmbedAsset[] {
  return db
    .select()
    .from(embedAssets)
    .where(isNotNull(embedAssets.storedAt))
    .orderBy(asc(embedAssets.lastAccessAt))
    .all();
}

/** Hashes per `IN (…)`. A sweep that frees a full cache names every asset it
 * unlinked, which is more bound parameters than SQLite accepts in one
 * statement. */
const EVICTION_BATCH = 500;

/** Clears the file state of the assets the sweep unlinked. The mapping stays,
 * so a later request re-fetches instead of 404ing. */
export function markEvicted(db: SessionDatabase, hashes: readonly string[]): number {
  let cleared = 0;
  for (let index = 0; index < hashes.length; index += EVICTION_BATCH) {
    cleared += db
      .update(embedAssets)
      .set({ contentType: null, bytes: 0, storedAt: null })
      .where(inArray(embedAssets.hash, hashes.slice(index, index + EVICTION_BATCH)))
      .returning({ hash: embedAssets.hash })
      .all().length;
  }
  return cleared;
}

/**
 * Drops mappings that hold no bytes and have not been asked for since
 * `before`. A snapshot that still points at one re-registers it on its next
 * hydration; one that nothing renders any more is rubbish either way.
 */
export function pruneUnused(db: SessionDatabase, before: number): number {
  return db
    .delete(embedAssets)
    .where(and(isNull(embedAssets.storedAt), lt(embedAssets.lastAccessAt, before)))
    .returning({ hash: embedAssets.hash })
    .all().length;
}
