import { createHash, randomBytes } from "node:crypto";

import type { SessionDatabase } from "@session/db";
import {
  MAX_SESSION_WIDGET_BYTES,
  baseRemarkPlugins,
  buildTimelineItems,
  collapseImageMarkers,
  escapeWikilinkTablePipes,
  fencedBlockIsClosed,
  isSessionWidgetInfo,
  normalizeLatexMathDelimiters,
  type ResearchNodeContent,
  type WidgetMarkdownNode,
} from "@session/shared";
import { Hono } from "hono";
import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { AppEnv, ServerDeps } from "../deps.js";

interface Preview {
  userId: string;
  html: string;
  expiresAt: number;
}
const stores = new WeakMap<SessionDatabase, Map<string, Preview>>();
const TTL = 60 * 60 * 1000;
const MAX_PAGES = 256;
const MAX_PAGES_PER_USER = 64;
function storeFor(db: SessionDatabase) {
  let store = stores.get(db);
  if (!store) {
    store = new Map();
    stores.set(db, store);
  }
  return store;
}

/** The least recently used page for `userId`, or for an account with the
 * highest page count. Map order is recency order: minting inserts at the end
 * and serving a page re-inserts it. */
function evictionCandidate(store: Map<string, Preview>, userId?: string): string | undefined {
  if (userId !== undefined) {
    for (const [token, page] of store) if (page.userId === userId) return token;
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const page of store.values()) counts.set(page.userId, (counts.get(page.userId) ?? 0) + 1);
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

/** Expiring render cache only. The answer remains the durable source: callers
 * pass HTML resolved from a stored answer (`answerWidgetSource`), never HTML a
 * client supplied. Each account can cache at most 64 pages. When the shared
 * cache is full, evict the least recently used page from an account with the
 * highest page count. */
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
  let owned = 0;
  for (const page of store.values()) if (page.userId === userId) owned += 1;
  for (; owned >= MAX_PAGES_PER_USER; owned -= 1) store.delete(evictionCandidate(store, userId)!);
  while (store.size >= MAX_PAGES) store.delete(evictionCandidate(store)!);
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + TTL;
  store.set(token, { userId, html, expiresAt });
  return { token, expiresAt };
}

/** The widget block in a stored answer whose HTML has this SHA-256, or null.
 * Assistant text is parsed as the client renders it (the same Markdown
 * plugins and pre-parse rewrites); only blocks with a closing fence count. */
export function answerWidgetSource(content: ResearchNodeContent, sha256: string): string | null {
  const texts = new Set<string>();
  for (const turn of content.turns)
    if (turn.role === "assistant")
      for (const block of turn.blocks) if (block.type === "text") texts.add(block.text);
  for (const item of buildTimelineItems(content.turns))
    if (item.role === "assistant")
      for (const block of item.blocks) if (block.type === "text") texts.add(block.text);
  if (content.inFlightText) texts.add(content.inFlightText);
  for (const text of texts) {
    if (!text.includes("session-html")) continue;
    const prepared = escapeWikilinkTablePipes(collapseImageMarkers(text));
    for (const source of new Set([text, prepared, normalizeLatexMathDelimiters(prepared)]))
      for (const html of completeWidgetBlocks(source))
        if (createHash("sha256").update(html, "utf8").digest("hex") === sha256) return html;
  }
  return null;
}

const widgetMarkdown = unified().use(remarkParse).use(baseRemarkPlugins);
function completeWidgetBlocks(source: string): string[] {
  const found: string[] = [];
  const visit = (node: WidgetMarkdownNode) => {
    if (node.type === "code" && isSessionWidgetInfo(node.lang)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const value = node.value ?? "";
      if (
        start !== undefined &&
        end !== undefined &&
        fencedBlockIsClosed(source.slice(start, end), value) &&
        Buffer.byteLength(value, "utf8") <= MAX_SESSION_WIDGET_BYTES
      )
        found.push(value);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(widgetMarkdown.runSync(widgetMarkdown.parse(source), source));
  return found;
}

export function widgetPreviewPolicy(publicOrigin: string) {
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${publicOrigin}; sandbox`;
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

const STATIC_WIDGET_STYLE =
  ":root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif}body{margin:0;padding:16px;overflow-wrap:anywhere}img,svg{max-width:100%}";

/** Parses with a WHATWG-conformant parser, with scripting disabled as in the
 * `sandbox` frame the page loads in, so `noscript` and other state-dependent
 * content parse as a browser parses them here. */
function sanitizedDocument(source: string): { markup: string; removed: number } {
  const document = parse(`<!doctype html><html><head></head><body>${source}</body></html>`, {
    scriptingEnabled: false,
  });
  const removed = sanitizeTree(document);
  return { markup: serialize(document), removed };
}

/** Static web boundary: no script allowance, same-origin privilege, forms or
 * navigation. Sanitation complements the response CSP and opaque sandbox.
 *
 * The result is checked to be a fixed point: parsing the serialized output
 * again finds nothing to remove and serializes to the same markup, so the
 * document a browser builds from it is the one that was sanitized. Input that
 * does not settle within a few rounds is served as escaped text. */
export function renderStaticWidget(source: string): string {
  let current = sanitizedDocument(source).markup;
  let settled = false;
  for (let round = 0; round < 4 && !settled; round += 1) {
    const next = sanitizedDocument(bodyMarkup(current));
    settled = next.removed === 0 && next.markup === current;
    current = next.markup;
  }
  const body = settled ? bodyMarkup(current) : `<pre>${escapeText(source)}</pre>`;
  return `<!DOCTYPE html><html><head><style>${STATIC_WIDGET_STYLE}</style></head><body>${body}</body></html>`;
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
    const page = /^[a-f0-9]{64}$/u.test(token) ? store.get(token) : undefined;
    if (!page || page.expiresAt <= Date.now()) {
      store.delete(token);
      return c.text("Preview expired. Reload the widget in Session.\n", 410, {
        "Cache-Control": "no-store",
      });
    }
    store.delete(token);
    store.set(token, page);
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
