// `POST /api/images` and `GET /images/:id` (`03-api-and-events.md` §5): the
// web's version of the desktop's `save_research_image`,
// `read_research_image` and `read_research_image_thumbnail`.
//
// Multipart rather than tRPC because the payload is bytes. An upload is
// pending until a question, note or draft names its id; `images.sweep` and
// the file sweep in `main.ts` remove what nothing names
// (`docs/02-domain-model-and-database.md` §3.6). Uploads are the signed-in
// caller's own; a read is answered for the image's owner and for anyone who
// may read a thread that names the image (`images.readable`, §5.16).

import { readFile } from "node:fs/promises";

import { images } from "@session/db";
import type { ResearchImageAttachment } from "@session/shared";
import { MAX_INPUT_IMAGE_BYTES } from "@session/shared";
import { Hono } from "hono";
import type { Context } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { RATE_LIMITS } from "../middleware/rateLimit.js";

import {
  IMAGE_TOO_LARGE,
  ImageRejection,
  imageStoragePath,
  makeThumbnail,
  prepareImage,
  sha256Hex,
  thumbnailPath,
  writeFileOnce,
} from "./images.js";

/** The largest multipart body read at all: one image at the input ceiling
 * plus room for the part headers. */
export const MAX_IMAGE_UPLOAD_BODY_BYTES = MAX_INPUT_IMAGE_BYTES + 64 * 1024;

/** Image bytes one account may keep. Pending images are swept after a day,
 * so this bounds what is attached to messages and drafts. */
export const MAX_IMAGE_BYTES_PER_USER = 512 * 1024 * 1024;

/** Longest kept original file name, in code points (`MAX_FILE_NAME_CHARS`). */
const MAX_FILE_NAME_CHARS = 255;

/**
 * The request body, refused once it passes `limit`. `formData()` buffers the
 * whole body in memory, so the bound is applied while it streams:
 * `Content-Length` is absent on a chunked upload and is the client's claim
 * either way.
 */
export function cappedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): { stream: ReadableStream<Uint8Array>; state: { exceeded: boolean } } {
  const state = { exceeded: false };
  let seen = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          state.exceeded = true;
          controller.error(new Error("upload too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, state };
}

/** The original file name reduced to its last path component without
 * control characters, or null when nothing is left (`clean_file_name`). */
export function cleanFileName(name: string | null | undefined): string | null {
  const last = name?.split(/[/\\]/).pop();
  if (last === undefined) {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = [...last.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")]
    .slice(0, MAX_FILE_NAME_CHARS)
    .join("")
    .trim();
  return cleaned === "" ? null : cleaned;
}

export interface ImageRoutesOptions {
  deps: ServerDeps;
  limiter: RateLimiter;
}

export function imageRoutes(options: ImageRoutesOptions): Hono<AppEnv> {
  const { deps, limiter } = options;
  const app = new Hono<AppEnv>();
  const refuse = (c: Context<AppEnv>, status: 400 | 401 | 404 | 413 | 415, error: string) =>
    c.json({ error }, status);

  app.post("/api/images", async (c) => {
    const user = c.get("user");
    if (!user) {
      return refuse(c, 401, "Authentication required. Sign in to continue.");
    }
    const budget = limiter.take(`uploads:${user.id}`, RATE_LIMITS.uploads);
    if (!budget.allowed) {
      return c.json({ error: "Upload rate limit exceeded. Try again later." }, 429, {
        "Retry-After": String(budget.retryAfter),
      });
    }
    // A declared length over the allowance is refused before the body is read.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_IMAGE_UPLOAD_BODY_BYTES) {
      return refuse(c, 413, IMAGE_TOO_LARGE);
    }
    const body = c.req.raw.body;
    if (body === null) {
      return refuse(c, 400, "Invalid request: multipart/form-data is required.");
    }
    const capped = cappedBody(body, MAX_IMAGE_UPLOAD_BODY_BYTES);
    let form: FormData;
    try {
      form = await new Response(capped.stream, {
        headers: { "Content-Type": c.req.header("content-type") ?? "" },
      }).formData();
    } catch {
      return capped.state.exceeded
        ? refuse(c, 413, IMAGE_TOO_LARGE)
        : refuse(c, 400, "Invalid request: multipart/form-data is required.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return refuse(c, 400, "No image was uploaded.");
    }

    let prepared;
    try {
      prepared = await prepareImage(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      if (error instanceof ImageRejection) {
        return refuse(c, error.status, error.message);
      }
      throw error;
    }
    if (
      images.storedBytes(deps.db, user.id) + prepared.bytes.byteLength >
      MAX_IMAGE_BYTES_PER_USER
    ) {
      return refuse(c, 413, "Storage quota exceeded for attached images.");
    }

    const sha256 = sha256Hex(prepared.bytes);
    const storagePath = imageStoragePath(deps.config.documentsDir, user.id, sha256);
    await writeFileOnce(storagePath, prepared.bytes);
    const thumbnail = await makeThumbnail(prepared.bytes, prepared.mime);
    if (thumbnail) {
      // Best effort, as on the desktop: a strip without one shows the image.
      await writeFileOnce(thumbnailPath(storagePath), thumbnail).catch((error: unknown) => {
        c.get("logger").warn({ error }, "could not save an image thumbnail");
      });
    }
    const row = images.create(deps.db, user.id, {
      sha256,
      mime: prepared.mime,
      byteSize: prepared.bytes.byteLength,
      width: prepared.width,
      height: prepared.height,
      fileName: cleanFileName(file.name),
      storagePath,
    });
    const attachment: ResearchImageAttachment = images.toAttachment(row);
    return c.json(attachment, 201);
  });

  app.get("/images/:id", async (c) => {
    // Readable by whoever may read a thread that names the image, guests
    // included for a public thread, and always by its uploader
    // (`images.readable`).
    const user = c.get("user");
    const row = images.readable(deps.db, user?.id ?? null, c.req.param("id"));
    if (!row) {
      return refuse(
        c,
        user ? 404 : 401,
        user ? "Not found" : "Authentication required. Sign in to continue.",
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(row.storagePath);
    } catch {
      return refuse(c, 404, "Not found");
    }
    let contentType = row.mime;
    if (c.req.query("thumb") !== undefined) {
      const path = thumbnailPath(row.storagePath);
      const stored = await readFile(path).catch(() => null);
      // A PNG or JPEG image whose thumbnail is missing gets one written now;
      // a GIF or WebP image is served whole.
      const thumbnail = stored ?? (await makeThumbnail(bytes, row.mime));
      if (thumbnail) {
        if (!stored) {
          await writeFileOnce(path, thumbnail).catch(() => undefined);
        }
        bytes = thumbnail;
        contentType = "image/jpeg";
      }
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // An id names one immutable file; who may read it depends on the
        // threads that name it, so shared caches must not keep it.
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(bytes.byteLength),
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  });

  return app;
}
