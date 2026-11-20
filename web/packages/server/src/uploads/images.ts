// Preparing an uploaded image for the research image store, with the
// desktop's rules (`src-tauri/src/research_images.rs`): the type is read from
// the file's leading bytes, never from what the browser reported; a PNG or
// JPEG over 5 MB or 8000 pixels on a side is downscaled to 2048 pixels and
// re-encoded as JPEG; a GIF or WebP image, which is not re-encoded, must
// already fit. PNG and JPEG images get a 256-pixel JPEG thumbnail beside
// them; a GIF or WebP image is its own thumbnail.

import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ResearchImageMimeType } from "@session/shared";
import {
  DOWNSCALED_IMAGE_SIDE,
  IMAGE_THUMBNAIL_SIDE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_INPUT_IMAGE_BYTES,
} from "@session/shared";
import sharp from "sharp";

/** Largest image decoded, per side (the desktop's decoder limit). */
const MAX_DECODED_SIDE = 16_384;

/** A refusal with the HTTP status the upload route answers with. */
export class ImageRejection extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "ImageRejection";
  }
}

export const UNSUPPORTED_IMAGE = "Only PNG, JPEG, GIF, and WebP images can be attached.";
export const IMAGE_TOO_LARGE = `Images must be ${MAX_INPUT_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`;

/** The format named by the file's leading bytes (`ImageFormat::sniff`). */
export function sniffImageMime(bytes: Uint8Array): ResearchImageMimeType | null {
  const startsWith = (prefix: readonly number[], at = 0) =>
    bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);
  const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(ascii("GIF87a")) || startsWith(ascii("GIF89a"))) return "image/gif";
  if (startsWith(ascii("RIFF")) && startsWith(ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** Whether the store re-encodes this format (PNG and JPEG). */
function decodes(mime: ResearchImageMimeType): boolean {
  return mime === "image/png" || mime === "image/jpeg";
}

function decoder(bytes: Uint8Array) {
  return sharp(bytes, { limitInputPixels: MAX_DECODED_SIDE * MAX_DECODED_SIDE });
}

function readFailure(error: unknown): ImageRejection {
  const detail = error instanceof Error ? error.message : String(error);
  return new ImageRejection(400, `The image could not be read: ${detail}`);
}

export interface PreparedImage {
  bytes: Buffer;
  mime: ResearchImageMimeType;
  width: number | null;
  height: number | null;
}

/** Width and height as displayed: after a JPEG's EXIF orientation, which
 * browsers apply to the stored original. */
async function dimensions(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await decoder(bytes).metadata();
    const size = metadata.autoOrient;
    return size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
  } catch {
    return null;
  }
}

/**
 * The bytes to store for an upload (`save_pending` and `prepare_image`). An
 * image within 5 MB and 8000 pixels per side is kept as uploaded. Throws an
 * {@link ImageRejection} for an empty, oversized or unsupported file.
 */
export async function prepareImage(input: Uint8Array): Promise<PreparedImage> {
  if (input.byteLength === 0) {
    throw new ImageRejection(400, "The image is empty.");
  }
  if (input.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new ImageRejection(413, IMAGE_TOO_LARGE);
  }
  const mime = sniffImageMime(input);
  if (mime === null) {
    throw new ImageRejection(415, UNSUPPORTED_IMAGE);
  }
  const size = await dimensions(input);
  const oversizedSide = size !== null && Math.max(size.width, size.height) > MAX_IMAGE_SIDE;
  if (input.byteLength <= MAX_IMAGE_BYTES && !oversizedSide) {
    return {
      bytes: Buffer.from(input),
      mime,
      width: size?.width ?? null,
      height: size?.height ?? null,
    };
  }
  if (!decodes(mime)) {
    throw new ImageRejection(
      413,
      oversizedSide
        ? `GIF and WebP images must be at most ${MAX_IMAGE_SIDE} pixels on each side.`
        : `GIF and WebP images must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`,
    );
  }
  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    output = await decoder(input)
      .rotate()
      .resize({
        width: DOWNSCALED_IMAGE_SIDE,
        height: DOWNSCALED_IMAGE_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw readFailure(error);
  }
  if (output.data.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageRejection(
      413,
      `The image is still over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB after downscaling. Use a smaller image.`,
    );
  }
  return {
    bytes: output.data,
    mime: "image/jpeg",
    width: output.info.width,
    height: output.info.height,
  };
}

/** A small JPEG of a PNG or JPEG image, upright and over white; null for a
 * GIF or WebP image or one that does not decode (`make_thumbnail`). */
export async function makeThumbnail(bytes: Uint8Array, mime: string): Promise<Buffer | null> {
  if (mime !== "image/png" && mime !== "image/jpeg") {
    return null;
  }
  try {
    return await decoder(bytes)
      .rotate()
      .resize({
        width: IMAGE_THUMBNAIL_SIDE,
        height: IMAGE_THUMBNAIL_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `${documentsDir}/<userId>/<sha256>`: content-addressed per account, so
 * the same image uploaded twice is stored once (`uploads/storage.ts`). */
export function imageStoragePath(documentsDir: string, userId: string, sha256: string): string {
  return join(documentsDir, userId, sha256);
}

/** The thumbnail beside an image file. It is kept and removed with it. */
export function thumbnailPath(storagePath: string): string {
  return `${storagePath}.thumb.jpg`;
}

/** Writes `bytes` to `path` unless a file is already there, through a
 * temporary name so a reader never sees a partial file. A file already
 * there has its modification time set to now, so the orphan sweep's grace
 * period (`storage.ts`) covers it until the caller's row is written. */
export async function writeFileOnce(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await stat(path);
    const at = new Date();
    await utimes(path, at, at).catch(() => undefined);
    return;
  } catch {
    // Absent: write it below.
  }
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
