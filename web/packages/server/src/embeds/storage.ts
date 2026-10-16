// Local image cache for embedded posts (`13-deployment-fly.md` §6).
//
// Hydrated snapshots point at `pbs.twimg.com` for avatars, photos, video
// posters, and link-card thumbnails. To prevent direct client requests to X
// and preserve image availability beyond external hosting lifetimes, hydration
// rewrites each image URL to `/embeds/<sha256>` and registers the mapping.
// Assets are fetched on first render and stored on the persistent Fly volume.
//
// Cache eviction is handled by `sweepEmbeds`, which unlinks least recently
// accessed files when storage exceeds `maxBytes` or an asset exceeds its idle
// threshold. Requests for evicted assets refetch from `source_url`.

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { embeds } from "@session/db";
import type { SessionDatabase } from "@session/db";
import type { QuotedTweetSnapshot, TweetSnapshot } from "@session/shared";

import type { Logger } from "../logger.js";
import { ResponseTooLargeError, readCapped } from "../net/readCapped.js";

type EmbedAsset = embeds.EmbedAsset;

/** Allowed source hosts for embed assets. Restricting origins prevents
 * `/embeds/<hash>` from operating as an open proxy. */
const EMBED_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com", "video.twimg.com"]);

/** The public path a rewritten snapshot carries. Relative, so a stored
 * snapshot does not bake in the origin it was hydrated on. */
export const EMBED_PATH_PREFIX = "/embeds/";

/** Per-asset size ceiling. Limits single-response downloads to prevent
 * excessive disk volume consumption. */
export const MAX_EMBED_BYTES = 8 * 1024 * 1024;

export const EMBED_FETCH_TIMEOUT_MS = 10_000;

/** Interval before an asset read updates `lastAccessAt` in the database,
 * bounding write frequency for frequently rendered images. */
export const EMBED_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Assets unaccessed for this duration are evicted regardless of cache size,
 * as inactive assets can be refetched on demand. */
export const EMBED_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** Mappings with no stored bytes and no requests for this duration are deleted. */
export const EMBED_ROW_MAX_IDLE_MS = 180 * 24 * 60 * 60 * 1000;

export function embedHash(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

/** `${SESSION_DATA_DIR}/embeds/<ab>/<hash>`: partitioned into two-character
 * subdirectories to avoid large flat directories. */
export function embedStoragePath(embedsDir: string, hash: string): string {
  return join(embedsDir, hash.slice(0, 2), hash);
}

/** Whether `value` is a URL this cache will fetch. */
export function isEmbeddableImageUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.protocol === "https:" && EMBED_HOSTS.has(url.hostname);
}

/**
 * Returns the cached `/embeds/<hash>` path for an image URL and registers the
 * mapping. URLs not handled by the embed cache are returned unchanged to
 * preserve rendering of external image sources.
 */
function cachedImageUrl(db: SessionDatabase, sourceUrl: string): string {
  if (!isEmbeddableImageUrl(sourceUrl)) {
    return sourceUrl;
  }
  const hash = embedHash(sourceUrl);
  embeds.register(db, { hash, sourceUrl });
  return `${EMBED_PATH_PREFIX}${hash}`;
}

function withCachedImages<T extends QuotedTweetSnapshot>(db: SessionDatabase, snapshot: T): T {
  const avatarUrl = snapshot.author.avatarUrl;
  const card = snapshot.card;
  return {
    ...snapshot,
    author: {
      ...snapshot.author,
      ...(avatarUrl === undefined ? {} : { avatarUrl: cachedImageUrl(db, avatarUrl) }),
    },
    media: snapshot.media.map((item) => ({
      ...item,
      imageUrl: cachedImageUrl(db, item.imageUrl),
    })),
    ...(card === undefined || card.imageUrl === undefined
      ? {}
      : { card: { ...card, imageUrl: cachedImageUrl(db, card.imageUrl) } }),
  };
}

/**
 * Rewrites cacheable image URLs in a snapshot to `/embeds/<hash>` paths and
 * registers mappings. Executed once during hydration to persist rewritten URLs
 * rather than transforming URLs on each render.
 */
export function cacheSnapshotImages(db: SessionDatabase, snapshot: TweetSnapshot): TweetSnapshot {
  const quoted = snapshot.quoted;
  return {
    ...withCachedImages(db, snapshot),
    ...(quoted === undefined ? {} : { quoted: withCachedImages(db, quoted) }),
  };
}

export interface EmbedBytes {
  bytes: Buffer;
  contentType: string;
}

async function readStored(embedsDir: string, asset: EmbedAsset): Promise<EmbedBytes | null> {
  if (asset.storedAt === null) {
    return null;
  }
  try {
    const bytes = await readFile(embedStoragePath(embedsDir, asset.hash));
    return { bytes, contentType: asset.contentType ?? "application/octet-stream" };
  } catch {
    // The database record indicates stored but the file is missing — caused
    // by an interrupted sweep or a volume snapshot rollback. Refetching uses
    // the standard cold path.
    return null;
  }
}

/** Fetches an asset from origin, rejecting responses that exceed size limits
 * or are not valid images, and writes it to the volume. */
async function fetchAsset(
  doFetch: typeof globalThis.fetch,
  embedsDir: string,
  asset: EmbedAsset,
): Promise<EmbedBytes | null> {
  if (!isEmbeddableImageUrl(asset.sourceUrl)) {
    return null;
  }
  const response = await doFetch(asset.sourceUrl, {
    headers: { "User-Agent": "session", Accept: "image/*" },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
  });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!response.ok || !contentType.startsWith("image/")) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  let bytes: Buffer;
  try {
    const read = await readCapped(response, MAX_EMBED_BYTES);
    bytes = Buffer.from(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return null;
    }
    throw error;
  }
  if (bytes.byteLength === 0) {
    return null;
  }
  const path = embedStoragePath(embedsDir, asset.hash);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return { bytes, contentType };
}

export interface EmbedStoreOptions {
  db: SessionDatabase;
  embedsDir: string;
  fetch: typeof globalThis.fetch;
  logger?: Logger | undefined;
}

/**
 * Read path for `GET /embeds/:hash`: returns stored files or fetches the
 * origin URL. Concurrent requests for the same uncached asset share a single
 * in-flight fetch request.
 */
export class EmbedStore {
  readonly #options: EmbedStoreOptions;
  readonly #inFlight = new Map<string, Promise<EmbedBytes | null>>();

  constructor(options: EmbedStoreOptions) {
    this.#options = options;
  }

  async read(hash: string, now: number = Date.now()): Promise<EmbedBytes | null> {
    const { db, embedsDir } = this.#options;
    const asset = embeds.get(db, hash);
    if (!asset) {
      return null;
    }
    if (now - asset.lastAccessAt > EMBED_TOUCH_INTERVAL_MS) {
      embeds.touch(db, hash, now);
    }
    const stored = await readStored(embedsDir, asset);
    if (stored) {
      return stored;
    }
    const existing = this.#inFlight.get(hash);
    if (existing) {
      return existing;
    }
    const pending = this.#fetchAndStore(asset).finally(() => this.#inFlight.delete(hash));
    this.#inFlight.set(hash, pending);
    return pending;
  }

  async #fetchAndStore(asset: EmbedAsset): Promise<EmbedBytes | null> {
    const { db, embedsDir, fetch: doFetch, logger } = this.#options;
    try {
      const fetched = await fetchAsset(doFetch, embedsDir, asset);
      if (!fetched) {
        return null;
      }
      embeds.markStored(db, asset.hash, {
        contentType: fetched.contentType,
        bytes: fetched.bytes.byteLength,
      });
      return fetched;
    } catch (error) {
      logger?.warn({ hash: asset.hash, error }, "could not fetch an embed asset");
      return null;
    }
  }
}

export interface EmbedSweepOptions {
  /** Bytes the cache may hold before the least recently served are unlinked. */
  maxBytes: number;
  maxIdleMs?: number;
  rowMaxIdleMs?: number;
  now?: number;
}

export interface EmbedSweepResult {
  evicted: number;
  freedBytes: number;
  prunedRows: number;
  storedBytes: number;
}

/**
 * Enforces cache storage limits: evicts assets idle beyond `maxIdleMs`,
 * followed by least recently accessed assets until usage is within `maxBytes`.
 * Files are unlinked before updating database records; any resulting orphaned
 * records are handled on subsequent read requests via refetching.
 */
export async function sweepEmbeds(
  options: EmbedStoreOptions & EmbedSweepOptions,
): Promise<EmbedSweepResult> {
  const { db, embedsDir, logger } = options;
  const now = options.now ?? Date.now();
  const maxIdleMs = options.maxIdleMs ?? EMBED_MAX_IDLE_MS;
  const idleBefore = now - maxIdleMs;
  const ordered = embeds.evictionOrder(db);
  let total = embeds.storedBytes(db);
  const doomed: EmbedAsset[] = [];
  for (const asset of ordered) {
    // `ordered` is sorted least recently accessed first; once an asset is
    // within the idle window and cache usage is within budget, all subsequent
    // assets are retained.
    if (asset.lastAccessAt >= idleBefore && total <= options.maxBytes) {
      break;
    }
    doomed.push(asset);
    total -= asset.bytes;
  }
  const unlinked: string[] = [];
  let freedBytes = 0;
  for (const asset of doomed) {
    try {
      await unlink(embedStoragePath(embedsDir, asset.hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger?.error({ hash: asset.hash, error }, "could not unlink an embed asset");
        continue;
      }
    }
    unlinked.push(asset.hash);
    freedBytes += asset.bytes;
  }
  embeds.markEvicted(db, unlinked);
  const prunedRows = embeds.pruneUnused(db, now - (options.rowMaxIdleMs ?? EMBED_ROW_MAX_IDLE_MS));
  return {
    evicted: unlinked.length,
    freedBytes,
    prunedRows,
    storedBytes: embeds.storedBytes(db),
  };
}
