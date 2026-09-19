// The bytes behind an embedded post's images (`13-deployment-fly.md` §6).
//
// A hydrated snapshot points at `pbs.twimg.com` for its avatar, photos, video
// posters and link-card thumbnails. Rendering those directly works, but it
// makes every reader of a card fetch from X, and it means a card outlives its
// images only for as long as X serves them. Hydration therefore rewrites each
// of those URLs to `/embeds/<sha256 of the URL>` and registers the mapping;
// the bytes are fetched the first time someone actually renders the card, and
// land on the same Fly volume the database and the uploads live on.
//
// The volume is finite, so this cache is explicitly disposable: `sweepEmbeds`
// unlinks the least recently served files once the cache passes its size cap
// or an asset goes untouched for long enough, and leaves the row behind. A
// request for an evicted hash re-fetches from `source_url`, so eviction costs
// a round trip and never a broken image.

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { embeds } from "@session/db";
import type { SessionDatabase } from "@session/db";
import type { QuotedTweetSnapshot, TweetSnapshot } from "@session/shared";

import type { Logger } from "../logger.js";

type EmbedAsset = embeds.EmbedAsset;

/** The hosts an embed asset may be fetched from. X serves every image a
 * snapshot carries from these, and the allowlist is what keeps a stored URL
 * from turning `/embeds/<hash>` into an open proxy. */
const EMBED_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com", "video.twimg.com"]);

/** The public path a rewritten snapshot carries. Relative, so a stored
 * snapshot does not bake in the origin it was hydrated on. */
export const EMBED_PATH_PREFIX = "/embeds/";

/** Per-asset ceiling. A timeline image is well under a megabyte; the cap is
 * what stops a wrong answer from filling the volume in one request. */
export const MAX_EMBED_BYTES = 8 * 1024 * 1024;

export const EMBED_FETCH_TIMEOUT_MS = 10_000;

/** How stale an access time may be before the read path writes a new one.
 * Eviction order only needs to be roughly right, and a write per image
 * request would be a write per rendered card. */
export const EMBED_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** An asset untouched for this long is evicted whether or not the cache is
 * over its cap: nothing is rendering it, and the row can re-fetch it. */
export const EMBED_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** Mappings with no bytes and no request in this long are dropped outright. */
export const EMBED_ROW_MAX_IDLE_MS = 180 * 24 * 60 * 60 * 1000;

export function embedHash(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

/** `${SESSION_DATA_DIR}/embeds/<ab>/<hash>`: fanned out one level so a cache
 * of tens of thousands of images is not one directory. */
export function embedStoragePath(embedsDir: string, hash: string): string {
  return join(embedsDir, hash.slice(0, 2), hash);
}

/** Whether `value` is a URL this cache will fetch. */
export function isEmbeddableImageUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.protocol === "https:" && EMBED_HOSTS.has(url.hostname);
}

/**
 * The cached path for one image URL, registering the mapping as a side effect.
 * A URL the cache will not fetch is returned unchanged, so a snapshot that
 * points somewhere unexpected still renders the way it did before.
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
 * The snapshot as it is stored: every image URL the cache can serve replaced
 * by its `/embeds/<hash>` path, and the mapping back to the origin registered.
 * Applied once, at hydration, so the rewrite is part of the persisted format
 * rather than something every render has to redo.
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
    // The row says stored and the file is gone — a sweep that was interrupted
    // between the unlink and the update, or a volume restored from a snapshot
    // older than the row. Re-fetching is the same work as the cold path.
    return null;
  }
}

/** Fetches one asset from its origin, refusing anything that is not an image
 * inside the cap, and writes it to the volume. */
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
  if (!response.ok) {
    return null;
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_EMBED_BYTES) {
    return null;
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!contentType.startsWith("image/")) {
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EMBED_BYTES) {
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
 * The read path behind `GET /embeds/:hash`: the stored file, or one fetch of
 * the origin URL the row remembers. Concurrent requests for the same cold
 * asset share one fetch — a feed of cards from one author asks for the same
 * avatar as many times as there are cards on screen.
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
 * Brings the cache back inside its budget: every asset idle past
 * `maxIdleMs` goes, and then the least recently served go until the total fits
 * `maxBytes`. Files are unlinked before their rows are cleared, so a crash in
 * the middle leaves rows claiming bytes that are gone — which the read path
 * already handles by re-fetching.
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
    // `ordered` is least recently served first, so once an asset is young
    // enough to keep and the cache fits its budget, everything after it does
    // too.
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
