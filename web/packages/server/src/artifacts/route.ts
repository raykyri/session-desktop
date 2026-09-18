// `GET /a/:token` on the artifact origin (`11-artifacts-and-browser.md` §2).
//
// The session cookie never reaches this host, so the token is the whole
// authorization. Everything else here exists to keep a document the user
// uploaded from executing as a page: no sniffing, no referrer, HTML served as
// text, and a per-response CSP that allows nothing.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { artifacts } from "@session/db";
import { Hono } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";

import { readFont } from "./fonts.js";
import {
  errorPageContentSecurityPolicy,
  parseBodyFont,
  renderedPageContentSecurityPolicy,
  renderErrorPage,
  renderMarkdownPage,
  renderTextPage,
} from "./page.js";

/** `default-src 'none'` with inline styles for the rendered text page; no
 * script, no frames, no network. `frame-ancestors` names the app rather than
 * relying on `X-Frame-Options`, which cannot express "this one other origin"
 * and would block the preview panel outright. */
export function artifactContentSecurityPolicy(publicOrigin: string): string {
  return `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors ${publicOrigin}`;
}

/** Types the panel can show inline. Everything else downloads. */
const INLINE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
]);

/** HTML is never served as HTML: an uploaded page would otherwise run on the
 * artifact origin, which is same-origin with the preview iframe. */
export function servedContentType(mime: string): string {
  if (mime === "text/html" || mime === "application/xhtml+xml" || mime.startsWith("text/")) {
    return "text/plain; charset=utf-8";
  }
  return mime;
}

/**
 * `Content-Disposition` for a name the user chose. Header values are
 * ByteStrings, so a name with a character outside Latin-1 would throw where
 * the response is constructed; the ASCII form is the fallback and `filename*`
 * (RFC 5987) carries the real one.
 */
export function contentDisposition(inline: boolean, name: string): string {
  const cleaned = name.replace(/\p{Cc}/gu, "").trim();
  const fallback = cleaned.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "");
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback === "" ? "document" : fallback}"; filename*=UTF-8''${encodeURIComponent(cleaned === "" ? "document" : cleaned)}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parses single byte ranges for PDF viewers and iframe media streams; multipart byte ranges are not supported. */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }
  if (rawStart === "") {
    const length = Number(rawEnd);
    // Empty files and zero-length ranges return the full empty response body.
    if (length <= 0 || size === 0) {
      return null;
    }
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) {
    return null;
  }
  return { start, end };
}

/** How a document is presented when it is not streamed as-is. Markdown is
 * rendered; the plain-text family is shown in the same page as source, so a
 * `.txt` beginning with `#` is not turned into a heading. `text/html` is
 * deliberately absent: it stays `text/plain` (`11-artifacts-and-browser.md`
 * §2). */
export type RenderKind = "markdown" | "text";

export function renderKind(mime: string): RenderKind | null {
  switch (mime.split(";")[0]?.trim().toLowerCase()) {
    case "text/markdown":
    case "text/x-markdown":
      return "markdown";
    case "text/plain":
    case "text/csv":
    case "application/json":
    case "text/json":
      return "text";
    default:
      return null;
  }
}

/** Rendering reads the whole document into memory and doubles it as HTML; past
 * this size the document is streamed as text instead, which `Range` can page
 * through. */
export const MAX_RENDERED_BYTES = 4 * 1024 * 1024;

/** A framed error: the panel reads the status off the `postMessage` the body
 * sends and re-mints (`11-artifacts-and-browser.md` §3). */
function errorResponse(publicOrigin: string, status: 404 | 410, message: string): Response {
  return new Response(renderErrorPage(status, message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": errorPageContentSecurityPolicy(publicOrigin),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
}

export function artifactRoutes(deps: ServerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/a/:token", async (c) => {
    // One hostname serves the app and the artifacts in development; the check
    // is what keeps a token URL from resolving on the app origin, where the
    // session cookie would be attached.
    const host = c.req.header("host");
    if (host !== deps.config.artifactHost) {
      return c.text("not found\n", 404);
    }
    const resolved = artifacts.resolveToken(deps.db, c.req.param("token"));
    if (!resolved) {
      // 410: the client re-mints rather than treating it as a broken link.
      return errorResponse(deps.config.publicOrigin, 410, "This preview link expired.");
    }
    let size: number;
    try {
      size = (await stat(resolved.storagePath)).size;
    } catch {
      return errorResponse(deps.config.publicOrigin, 404, "This document is unavailable.");
    }

    // `?raw=1` opts out of rendering, as on the desktop; `?session-body-font=`
    // picks the body face the page loads from this origin.
    const font = parseBodyFont(c.req.query("session-body-font"));
    const kind = renderKind(resolved.mime);
    if (c.req.query("raw") !== "1" && kind !== null && size <= MAX_RENDERED_BYTES) {
      const source = await readFile(resolved.storagePath, "utf8");
      const html =
        kind === "markdown"
          ? renderMarkdownPage(resolved.name, source, font)
          : renderTextPage(resolved.name, source, font);
      // Rendered HTML output differs from raw stored bytes, so Range requests are ignored and Accept-Ranges: none is set.
      return c.body(html, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": renderedPageContentSecurityPolicy(deps.config.publicOrigin),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
        "Accept-Ranges": "none",
        "Content-Disposition": contentDisposition(true, `${resolved.name}.html`),
      });
    }

    const contentType = servedContentType(resolved.mime);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Security-Policy": artifactContentSecurityPolicy(deps.config.publicOrigin),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      "Content-Disposition": contentDisposition(
        INLINE_TYPES.has(contentType.split(";")[0] ?? ""),
        resolved.name,
      ),
    };

    const range = parseRange(c.req.header("range"), size);
    if (range) {
      const length = range.end - range.start + 1;
      const stream = createReadStream(resolved.storagePath, { start: range.start, end: range.end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(length),
        },
      });
    }
    const stream = createReadStream(resolved.storagePath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  });

  // The faces the rendered pages ask for. Public on this origin and immutable:
  // the files are release assets, not user data, and the token protects the
  // document, not the typeface.
  app.get("/__session/fonts/:file", (c) => {
    if (c.req.header("host") !== deps.config.artifactHost) {
      return c.text("not found\n", 404);
    }
    const bytes = readFont(c.req.param("file"));
    if (!bytes) {
      return c.text("not found\n", 404);
    }
    return c.body(bytes, 200, {
      "Content-Type": "font/woff2",
      "Content-Length": String(bytes.byteLength),
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  return app;
}
