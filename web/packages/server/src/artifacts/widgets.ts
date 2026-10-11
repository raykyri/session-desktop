import { randomBytes } from "node:crypto";

import type { SessionDatabase } from "@session/db";
import { MAX_SESSION_WIDGET_BYTES } from "@session/shared";
import { Hono } from "hono";
import { parseHTML } from "linkedom";

import type { AppEnv, ServerDeps } from "../deps.js";

interface Preview {
  userId: string;
  html: string;
  expiresAt: number;
}
const stores = new WeakMap<SessionDatabase, Map<string, Preview>>();
const TTL = 60 * 60 * 1000;
const MAX_PAGES = 256;
function storeFor(db: SessionDatabase) {
  let store = stores.get(db);
  if (!store) {
    store = new Map();
    stores.set(db, store);
  }
  return store;
}

/** Expiring render cache only. The answer remains the durable source. */
export function mintWidgetPreview(
  db: SessionDatabase,
  userId: string,
  html: string,
  now = Date.now(),
) {
  if (Buffer.byteLength(html, "utf8") > MAX_SESSION_WIDGET_BYTES)
    throw new Error("widget exceeds 64 KiB");
  const store = storeFor(db);
  for (const [token, page] of store) if (page.expiresAt <= now) store.delete(token);
  const owned = [...store].filter(([, page]) => page.userId === userId);
  if (owned.length >= 64) store.delete(owned[0]![0]);
  while (store.size >= MAX_PAGES) store.delete(store.keys().next().value!);
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + TTL;
  store.set(token, { userId, html, expiresAt });
  return { token, expiresAt };
}

export function widgetPreviewPolicy(publicOrigin: string) {
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${publicOrigin}; sandbox`;
}

// Minimal server-side DOM shape; Node's TypeScript library excludes browser globals.
interface WidgetElement {
  namespaceURI: string | null;
  localName: string;
  attributes: Iterable<{ name: string; value: string }>;
  textContent: string | null;
  remove(): void;
  removeAttribute(name: string): void;
  prepend(element: WidgetElement): void;
}
interface WidgetDocument {
  head: WidgetElement;
  querySelectorAll(selector: string): Iterable<WidgetElement>;
  createElement(name: string): WidgetElement;
  toString(): string;
}
const parseWidgetHtml = parseHTML as unknown as (html: string) => { document: WidgetDocument };

/** Static web boundary: no script allowance, same-origin privilege, forms or
 * navigation. Sanitation complements the response CSP and opaque sandbox. */
export function renderStaticWidget(html: string): string {
  const { document } = parseWidgetHtml(
    `<!doctype html><html><head></head><body>${html.replace(/http-equiv/giu, "data-http-equiv")}</body></html>`,
  );
  for (const element of document.querySelectorAll(
    "script,iframe,frame,frameset,object,embed,base,meta,link,template,set,animate,animateMotion,animateTransform",
  ))
    element.remove();
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const localSvgReference =
        element.namespaceURI === "http://www.w3.org/2000/svg" &&
        /^(?:use|linearGradient|radialGradient|pattern|textPath)$/u.test(element.localName) &&
        /^(?:href|xlink:href)$/iu.test(attribute.name) &&
        /^#[a-zA-Z_][a-zA-Z0-9_.:-]*$/u.test(attribute.value);
      if (localSvgReference) continue;
      if (
        /^on/iu.test(attribute.name) ||
        /^(?:href|xlink:href|action|formaction|target|autofocus|autoplay|srcdoc)$/iu.test(
          attribute.name,
        )
      )
        element.removeAttribute(attribute.name);
    }
  }
  const style = document.createElement("style");
  style.textContent =
    ":root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif}body{margin:0;padding:16px;overflow-wrap:anywhere}img,svg{max-width:100%}";
  document.head.prepend(style);
  return document.toString();
}

export function widgetRoutes(deps: ServerDeps) {
  const app = new Hono<AppEnv>();
  app.on(["GET", "HEAD"], "/w/:token", (c) => {
    if (c.req.header("host") !== deps.config.artifactHost) return c.text("not found\n", 404);
    const token = c.req.param("token");
    const store = storeFor(deps.db);
    const page = /^[a-f0-9]{64}$/u.test(token) ? store.get(token) : undefined;
    if (!page || page.expiresAt <= Date.now()) {
      store.delete(token);
      return c.text("Preview expired. Reload the widget in Session.\n", 410, {
        "Cache-Control": "no-store",
      });
    }
    return new Response(c.req.method === "HEAD" ? null : renderStaticWidget(page.html), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": widgetPreviewPolicy(deps.config.publicOrigin),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-DNS-Prefetch-Control": "off",
      },
    });
  });
  return app;
}
