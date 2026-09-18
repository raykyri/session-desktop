// `POST /uploads` (`03-api-and-events.md` §5, `04-agent-runtime.md` §8).
//
// Multipart rather than tRPC because the payload is bytes, not JSON. The
// response is the same `DocumentInfo[]` the composer already renders.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { documents } from "@session/db";
import type { DocumentInfo } from "@session/shared";
import { Hono } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { RATE_LIMITS } from "../middleware/rateLimit.js";

import { extractDocumentText } from "./extract.js";
import {
  MAX_DOCUMENTS_PER_QUESTION,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_BYTES_PER_USER,
  extractionKind,
  resolveMimeType,
} from "./limits.js";

export interface UploadRoutesOptions {
  deps: ServerDeps;
  limiter: RateLimiter;
}

/** The largest multipart body that will be read at all: every file at its
 * ceiling plus room for the part headers. */
export const MAX_UPLOAD_BODY_BYTES = MAX_DOCUMENT_BYTES * MAX_DOCUMENTS_PER_QUESTION + 1024 * 1024;

/**
 * The request body, refused once it passes `limit`. `formData()` buffers the
 * whole body in memory, so the bound has to be applied while it streams:
 * `Content-Length` is absent on a chunked upload and is the client's claim
 * either way.
 */
export function cappedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): { stream: ReadableStream; state: { exceeded: boolean } } {
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

/** `${SESSION_DATA_DIR}/documents/<userId>/<sha256>`: content-addressed, so
 * the same file attached twice is stored once (`04` §8). */
export function documentStoragePath(documentsDir: string, userId: string, sha256: string): string {
  return join(documentsDir, userId, sha256);
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function uploadRoutes(options: UploadRoutesOptions): Hono<AppEnv> {
  const { deps, limiter } = options;
  const app = new Hono<AppEnv>();

  app.post("/uploads", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required. Sign in to continue." }, 401);
    }
    const budget = limiter.take(`uploads:${user.id}`, RATE_LIMITS.uploads);
    if (!budget.allowed) {
      return c.json({ error: "Upload rate limit exceeded. Try again later." }, 429, {
        "Retry-After": String(budget.retryAfter),
      });
    }
    // A declared length over the whole allowance is refused before any body is
    // read, so an oversized POST costs one header parse.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BODY_BYTES) {
      return c.json({ error: "Upload exceeds maximum allowed size" }, 413);
    }

    const body = c.req.raw.body;
    if (body === null) {
      return c.json({ error: "Invalid request: multipart/form-data is required." }, 400);
    }
    const capped = cappedBody(body, MAX_UPLOAD_BODY_BYTES);
    let form: FormData;
    try {
      form = await new Response(capped.stream, {
        headers: { "Content-Type": c.req.header("content-type") ?? "" },
      }).formData();
    } catch {
      return capped.state.exceeded
        ? c.json({ error: "Upload exceeds maximum allowed size" }, 413)
        : c.json({ error: "expected a multipart upload" }, 400);
    }
    const workspaceId = form.get("workspaceId");
    if (typeof workspaceId !== "string" || workspaceId === "") {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (files.length === 0) {
      return c.json({ error: "No files were uploaded." }, 400);
    }
    if (files.length > MAX_DOCUMENTS_PER_QUESTION) {
      return c.json(
        { error: `A maximum of ${MAX_DOCUMENTS_PER_QUESTION} files may be attached per question.` },
        400,
      );
    }

    let stored = documents.totalBytes(deps.db, user.id);
    const results: DocumentInfo[] = [];
    for (const file of files) {
      if (file.size > MAX_DOCUMENT_BYTES) {
        return c.json({ error: `${file.name} is larger than 20 MiB` }, 413);
      }
      const mime = resolveMimeType(file.type, file.name);
      const kind = mime === null ? null : extractionKind(mime);
      if (mime === null || kind === null) {
        return c.json({ error: `${file.name} is not a supported document type` }, 415);
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        return c.json({ error: `${file.name} is larger than 20 MiB` }, 413);
      }
      const sha256 = sha256Of(bytes);
      const existing = documents
        .list(deps.db, user.id)
        .find((document) => document.sha256 === sha256);
      if (existing) {
        results.push(existing);
        continue;
      }
      if (stored + bytes.byteLength > MAX_DOCUMENT_BYTES_PER_USER) {
        return c.json({ error: "Storage quota exceeded for attached documents." }, 413);
      }
      const storagePath = documentStoragePath(deps.config.documentsDir, user.id, sha256);
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(storagePath, bytes);
      stored += bytes.byteLength;

      let document: DocumentInfo;
      try {
        document = documents.create(deps.db, user.id, {
          workspaceId,
          name: file.name,
          mime,
          byteSize: bytes.byteLength,
          sha256,
          storagePath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, message.includes("was not found") ? 404 : 400);
      }

      const extraction = await extractDocumentText(kind, bytes);
      if (extraction.status === "failed") {
        c.get("logger").warn(
          { documentId: document.id, error: extraction.error },
          "document text extraction failed",
        );
      }
      results.push(
        documents.setExtraction(deps.db, user.id, document.id, {
          status: extraction.status,
          pageCount: extraction.pageCount,
          pages: extraction.pages,
        }),
      );
    }
    return c.json(results, 201);
  });

  return app;
}
