// Widget pages on the artifact origin (`11-artifacts-and-browser.md` §3).
//
// `artifacts.prepareWidget` mints two capability URLs for one widget block of
// a stored answer: the static page and, while widget scripts are allowed
// (`artifacts/site.ts`), the run page. `GET /w/:token` serves them only on the
// artifact host and only as a frame's document. The page itself is in
// `widgetPage.ts`.

import { randomBytes } from "node:crypto";

import type { SessionDatabase } from "@session/db";
import { MAX_SESSION_WIDGET_BYTES } from "@session/shared";
import { Hono } from "hono";
import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";

import type { AppEnv, ServerDeps } from "../deps.js";

import {
  WIDGET_PERMISSIONS_POLICY,
  neutralizeHttpEquiv,
  widgetPage,
  widgetPagePolicy,
  type WidgetPageMode,
} from "./widgetPage.js";

export { answerWidgetSource } from "./answerBlocks.js";

interface Preview {
  userId: string;
  html: string;
  expiresAt: number;
  staticToken: string;
  /** Null while widget scripts are not allowed. */
  runToken: string | null;
}
interface PreviewStore {
  /** Keyed by the static token; Map order is recency order. */
  previews: Map<string, Preview>;
  /** Every live token, static and run, to its preview's static token. */
  tokens: Map<string, { key: string; mode: WidgetPageMode }>;
}
const stores = new WeakMap<SessionDatabase, PreviewStore>();
const TTL = 60 * 60 * 1000;
const MAX_PAGES = 256;
const MAX_PAGES_PER_USER = 64;
function storeFor(db: SessionDatabase): PreviewStore {
  let store = stores.get(db);
  if (!store) {
    store = { previews: new Map(), tokens: new Map() };
    stores.set(db, store);
  }
  return store;
}

function removePreview(store: PreviewStore, key: string | undefined): void {
  if (key === undefined) return;
  const preview = store.previews.get(key);
  if (!preview) return;
  store.previews.delete(key);
  store.tokens.delete(preview.staticToken);
  if (preview.runToken !== null) store.tokens.delete(preview.runToken);
}

/** The least recently used preview for `userId`, or for an account with the
 * highest preview count. Map order is recency order: minting inserts at the
 * end and serving a page re-inserts it. */
function evictionCandidate(store: PreviewStore, userId?: string): string | undefined {
  if (userId !== undefined) {
    for (const [key, page] of store.previews) if (page.userId === userId) return key;
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const page of store.previews.values())
    counts.set(page.userId, (counts.get(page.userId) ?? 0) + 1);
  let highestCountUserId: string | undefined;
  let highestCount = 0;
  for (const [user, count] of counts)
    if (count > highestCount) {
      highestCountUserId = user;
      highestCount = count;
    }
  return highestCountUserId === undefined
    ? undefined
    : evictionCandidate(store, highestCountUserId);
}

const newToken = () => randomBytes(32).toString("hex");

/** Expiring render cache only. The answer remains the durable source: callers
 * pass HTML resolved from a stored answer or a stored revision, never HTML a
 * client supplied. Each account can cache at most 64 previews. When the shared
 * cache is full, evict the least recently used preview from an account with
 * the highest preview count. `scripts` decides whether a run token exists. */
export function mintWidgetPreview(
  db: SessionDatabase,
  userId: string,
  html: string,
  options: { scripts: boolean; now?: number },
) {
  if (Buffer.byteLength(html, "utf8") > MAX_SESSION_WIDGET_BYTES)
    throw new Error("widget exceeds 64 KiB");
  const now = options.now ?? Date.now();
  const store = storeFor(db);
  for (const [key, page] of store.previews) if (page.expiresAt <= now) removePreview(store, key);
  let owned = 0;
  for (const page of store.previews.values()) if (page.userId === userId) owned += 1;
  for (; owned >= MAX_PAGES_PER_USER; owned -= 1)
    removePreview(store, evictionCandidate(store, userId));
  while (store.previews.size >= MAX_PAGES) removePreview(store, evictionCandidate(store));
  const staticToken = newToken();
  const runToken = options.scripts ? newToken() : null;
  const expiresAt = now + TTL;
  store.previews.set(staticToken, { userId, html, expiresAt, staticToken, runToken });
  store.tokens.set(staticToken, { key: staticToken, mode: "static" });
  if (runToken !== null) store.tokens.set(runToken, { key: staticToken, mode: "run" });
  return { staticToken, runToken, expiresAt };
}

const NS_HTML = parse5Html.NS.HTML;
const NS_SVG = parse5Html.NS.SVG;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** Elements removed with their content. Besides executable and embedding
 * elements, this covers every element whose content the HTML parser treats as
 * raw text or switches on parser state (`noscript` depends on whether
 * scripting is enabled), so the stored markup cannot parse differently in a
 * browser than it did here. */
const REMOVED_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "base",
  "meta",
  "link",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "discard",
]);
const REMOVED_ATTRIBUTES =
  /^(?:href|action|formaction|target|formtarget|autofocus|autoplay|srcdoc|http-equiv|ping)$/iu;
const LOCAL_REFERENCE_ELEMENTS = /^(?:use|lineargradient|radialgradient|pattern|textpath|mpath)$/iu;

/** Removes disallowed nodes and attributes in place; returns how many it
 * removed. Comments (and the bogus comments that processing instructions and
 * HTML-namespace CDATA sections parse to) are removed: their serialization is
 * where HTML parsers have historically disagreed (`--!>`, `<!-->`). */
function sanitizeTree(parent: ParentNode): number {
  let removed = 0;
  for (const child of [...parent.childNodes]) {
    if (defaultTreeAdapter.isCommentNode(child)) {
      defaultTreeAdapter.detachNode(child);
      removed += 1;
      continue;
    }
    if (!defaultTreeAdapter.isElementNode(child)) continue;
    const element: Element = child;
    const name = element.tagName.toLowerCase();
    // `style` is raw text only in the HTML namespace; inside SVG or MathML
    // its content is markup, so keep it only where a browser reads it as CSS.
    const foreignStyle = name === "style" && element.namespaceURI !== NS_HTML;
    if (REMOVED_ELEMENTS.has(name) || foreignStyle) {
      defaultTreeAdapter.detachNode(element);
      removed += 1;
      continue;
    }
    const kept = element.attrs.filter((attribute) => {
      const localSvgReference =
        element.namespaceURI === NS_SVG &&
        LOCAL_REFERENCE_ELEMENTS.test(name) &&
        attribute.name.toLowerCase() === "href" &&
        /^#[a-zA-Z_][a-zA-Z0-9_.:-]*$/u.test(attribute.value);
      if (localSvgReference) return true;
      return !(/^on/iu.test(attribute.name) || REMOVED_ATTRIBUTES.test(attribute.name));
    });
    removed += element.attrs.length - kept.length;
    element.attrs = kept;
    removed += sanitizeTree(element);
  }
  return removed;
}

/** Parses with a WHATWG-conformant parser. No `noscript` survives
 * sanitation, so the output parses the same with scripting on (the frame
 * runs Session's scripts) or off. */
function sanitizedDocument(source: string): { markup: string; removed: number } {
  const document = parse(`<!doctype html><html><head></head><body>${source}</body></html>`, {
    scriptingEnabled: false,
  });
  const removed = sanitizeTree(document);
  return { markup: serialize(document), removed };
}

/**
 * The static page: the widget's markup and CSS with no script allowance,
 * same-origin privilege, forms or navigation. Sanitation complements the
 * page's CSP (which admits only Session's hashed scripts) and the opaque
 * sandbox, since this page loads without a click.
 *
 * The sanitized body is checked to be a fixed point: parsing the serialized
 * output again finds nothing to remove and serializes to the same markup, so
 * the document a browser builds from it is the one that was sanitized. Input
 * that does not settle within a few rounds is served as escaped text.
 */
export function renderStaticWidget(source: string): string {
  let current = sanitizedDocument(source).markup;
  let settled = false;
  for (let round = 0; round < 4 && !settled; round += 1) {
    const next = sanitizedDocument(bodyMarkup(current));
    settled = next.removed === 0 && next.markup === current;
    current = next.markup;
  }
  return widgetPage(settled ? bodyMarkup(current) : `<pre>${escapeText(source)}</pre>`, "static");
}

/** The run page: the widget's HTML as written, with `http-equiv` renamed so
 * no pragma (a refresh) applies. */
export function renderRunWidget(source: string): string {
  return widgetPage(neutralizeHttpEquiv(source), "run");
}

function bodyMarkup(markup: string): string {
  const document = parse(markup, { scriptingEnabled: false });
  const root = document.childNodes.find((node): node is Element =>
    defaultTreeAdapter.isElementNode(node),
  );
  const body = root?.childNodes.find(
    (node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "body",
  );
  return body ? serialize(body) : "";
}

function escapeText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function widgetRoutes(deps: ServerDeps) {
  const app = new Hono<AppEnv>();
  app.on(["GET", "HEAD"], "/w/:token", (c) => {
    if (c.req.header("host") !== deps.config.artifactHost) return c.text("not found\n", 404);
    // Served only as a frame's document: a top-level visit or a subresource
    // load of the preview URL is refused. Browsers send Fetch Metadata to
    // secure origins (the artifact origin is HTTPS, or localhost in
    // development), so a request without the header is refused as well.
    if (c.req.header("sec-fetch-dest") !== "iframe")
      return c.text("Widget previews load only inside Session.\n", 403, {
        "Cache-Control": "no-store",
      });
    const token = c.req.param("token");
    const store = storeFor(deps.db);
    const entry = /^[a-f0-9]{64}$/u.test(token) ? store.tokens.get(token) : undefined;
    const page = entry ? store.previews.get(entry.key) : undefined;
    if (!entry || !page || page.expiresAt <= Date.now()) {
      if (entry) removePreview(store, entry.key);
      return c.text("Preview expired. Reload the widget in Session.\n", 410, {
        "Cache-Control": "no-store",
      });
    }
    if (entry.mode === "run" && !deps.config.widgetScripts.allowed) {
      return c.text("Widget scripts are off on this server.\n", 410, {
        "Cache-Control": "no-store",
      });
    }
    // A run token is refused while scripts are off, however it was generated
    // (the policy is fixed per process; this is defence in depth).
    store.previews.delete(entry.key);
    store.previews.set(entry.key, page);
    const body =
      c.req.method === "HEAD"
        ? null
        : entry.mode === "run"
          ? renderRunWidget(page.html)
          : renderStaticWidget(page.html);
    return new Response(body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": widgetPagePolicy(entry.mode, deps.config.publicOrigin),
        "Permissions-Policy": WIDGET_PERMISSIONS_POLICY,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-DNS-Prefetch-Control": "off",
      },
    });
  });
  return app;
}
