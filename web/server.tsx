import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderLandingPage } from "./landing/LandingPage";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_PUBLIC_ORIGIN = "https://qmux.app";
const SITE_FONT_FILES = new Set([
  "DMSans-Variable-Latin.woff2",
  "ValleySans-Variable.woff2",
]);
const LANDING_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export interface ServerOptions {
  siteDir?: string;
  publicOrigin?: string;
}

export function createSessionWebServer(options: ServerOptions = {}) {
  return createServer(createSessionRequestHandler(options));
}

export function createSessionRequestHandler(options: ServerOptions = {}) {
  const siteDir = options.siteDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
  const publicOrigin = validatedPublicOrigin(
    options.publicOrigin ?? process.env.SESSION_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN,
  );

  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      await routeRequest(request, response, siteDir, publicOrigin);
    } catch (error) {
      console.error(error);
      sendHtml(response, 500, errorPage("Server error", "This page could not be loaded."));
    }
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  siteDir: string,
  publicOrigin: string,
) {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, {
      Allow: "GET, HEAD",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    const body = "ok\n";
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : body);
    return;
  }

  if (url.pathname === "/") {
    sendHtml(
      response,
      200,
      renderLandingPage(publicOrigin),
      "public, max-age=300",
      method,
    );
    return;
  }

  if (url.pathname === "/logo.png") {
    await serveStaticFile(response, join(siteDir, "logo.png"), "image/png", method);
    return;
  }

  if (url.pathname.startsWith("/fonts/")) {
    const filename = url.pathname.slice("/fonts/".length);
    if (SITE_FONT_FILES.has(filename)) {
      await serveStaticFile(
        response,
        join(siteDir, "fonts", filename),
        "font/woff2",
        method,
        "public, max-age=31536000, immutable",
      );
      return;
    }
  }

  sendHtml(response, 404, errorPage("Not found", "This page does not exist."), "no-store", method);
}

function validatedPublicOrigin(value: string) {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SESSION_PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
  }
  return parsed.origin;
}

async function serveStaticFile(
  response: ServerResponse,
  path: string,
  contentType: string,
  method: string,
  cacheControl = "public, max-age=86400",
) {
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.byteLength,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : body);
  } catch {
    sendHtml(response, 404, errorPage("Not found", "This page does not exist."), "no-store", method);
  }
}

function errorPage(title: string, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Session</title></head><body><main><a href="/">Session</a><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
  cacheControl = "no-store",
  method = "GET",
) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cacheControl,
    "Content-Security-Policy": LANDING_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : body);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const server = createSessionWebServer();
  server.listen(port, host, () => {
    console.log(`session web listening on http://${host}:${port}`);
  });
}
