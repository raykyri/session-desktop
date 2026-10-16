// The `web_fetch` tool (`04-agent-runtime.md` §6).
//
// Fetches a public web page and extracts readable text. Protections against
// SSRF and unauthorized network access include IP address validation
// (`ssrf.ts`), redirect re-validation, response size and timeout limits, and
// omitting credentials on outbound requests.

import { tool } from "ai";
import { z } from "zod";

import { readCapped } from "../../net/readCapped.js";

import type { RunToolContext } from "./context.js";
import { FETCH_BUDGET_SPENT } from "./context.js";
import { BlockedUrlError, assertFetchableUrl } from "./ssrf.js";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
export const MAX_FETCH_CHARS = 40_000;
export const MAX_REDIRECTS = 3;

export interface WebFetchOutput {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
  error?: string;
}

export const WEB_FETCH_DESCRIPTION =
  "Fetch one public web page or PDF and return its readable text. Use it on the search " +
  "results you intend to rely on, and on any URL the user gave you. Cite what you read as " +
  "an inline Markdown link.";

export const webFetchInputSchema = z.object({
  url: z.string().min(1).describe("Absolute http(s) URL of the page to read."),
});

export interface ExtractedPage {
  title?: string;
  text: string;
}

/**
 * The shapes this module uses out of `linkedom` and `@mozilla/readability`.
 *
 * Both packages type themselves against the DOM library, which this package
 * does not load (it is a Node server; `lib` is ES2022). Rather than pulling
 * DOM types into the build for three property reads, the dynamic imports
 * are narrowed to the required interfaces.
 */
interface ReadableElement {
  textContent: string | null;
}

interface ReadableDocument {
  body: ReadableElement | null;
  documentElement: ReadableElement | null;
  querySelector(selector: string): ReadableElement | null;
}

type ParseHtml = (html: string, globals?: { location?: string }) => { document: ReadableDocument };

interface ReadabilityArticle {
  title?: string | null;
  textContent?: string | null;
}

type ReadabilityConstructor = new (document: unknown) => { parse(): ReadabilityArticle | null };

/** Extracts readable text content from HTML using Readability over a
 * `linkedom` document, with a tag-stripping fallback for pages that
 * Readability cannot parse (such as a bare `<pre>` or framed document). */
export async function extractHtml(html: string, url: string): Promise<ExtractedPage> {
  try {
    const [linkedom, readability] = await Promise.all([
      import("linkedom") as Promise<unknown>,
      import("@mozilla/readability") as Promise<unknown>,
    ]);
    const { parseHTML } = linkedom as { parseHTML: ParseHtml };
    const { Readability } = readability as { Readability: ReadabilityConstructor };
    const { document } = parseHTML(html, { location: url });
    // Readability mutates the input document DOM, so fallback text is extracted
    // first: unparseable pages would otherwise yield an empty body.
    const title = document.querySelector("title")?.textContent?.trim();
    const bodyText = document.body?.textContent ?? "";
    // HTML fragments lacking `<html>` or `<body>` retain text on the root element;
    // `linkedom` does not insert implied elements.
    const whole = bodyText.trim() === "" ? (document.documentElement?.textContent ?? "") : bodyText;
    const article = new Readability(document).parse();
    const articleText = article?.textContent ?? "";
    if (articleText.trim() !== "") {
      const articleTitle = article?.title?.trim();
      return {
        ...(articleTitle ? { title: articleTitle } : {}),
        text: articleText.replace(/\n{3,}/g, "\n\n").trim(),
      };
    }
    return { ...(title ? { title } : {}), text: whole.replace(/\s+\n/g, "\n").trim() };
  } catch {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { ...(title ? { title } : {}), text };
  }
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedPage> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(bytes);
  const result = await extractText(document, { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  return { text: text.trim() };
}

/** Follows redirects iteratively, validating each `Location` target against
 * the SSRF address policy before issuing the request to prevent redirect-based
 * access to restricted IP addresses. */
async function fetchFollowingRedirects(
  ctx: RunToolContext,
  start: URL,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let url = start;
  for (let hop = 0; ; hop += 1) {
    const response = await ctx.fetch(url, {
      redirect: "manual",
      signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": "SessionResearchBot/1.0 (+https://session.dev)",
      },
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) {
      return { response, url };
    }
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) {
      throw new BlockedUrlError(`too many redirects (more than ${MAX_REDIRECTS})`);
    }
    const guardOptions = {
      ...(ctx.lookup ? { lookup: ctx.lookup } : {}),
      ...(ctx.allowHosts ? { allowHosts: ctx.allowHosts } : {}),
    };
    url = await assertFetchableUrl(new URL(location, url).toString(), guardOptions);
  }
}

export async function fetchReadablePage(
  ctx: RunToolContext,
  raw: string,
  signal: AbortSignal,
): Promise<WebFetchOutput> {
  const guardOptions = {
    ...(ctx.lookup ? { lookup: ctx.lookup } : {}),
    ...(ctx.allowHosts ? { allowHosts: ctx.allowHosts } : {}),
  };
  const start = await assertFetchableUrl(raw, guardOptions);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  const { response, url } = await fetchFollowingRedirects(ctx, start, timeout);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Remote server returned HTTP ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  // Responses exceeding the limit are truncated to `MAX_FETCH_BYTES`; responses
  // declaring a Content-Length exceeding the limit are rejected before reading.
  const { bytes } = await readCapped(response, MAX_FETCH_BYTES, { overflow: "truncate" });
  let page: ExtractedPage;
  if (contentType === "application/pdf") {
    page = await extractPdf(bytes);
  } else if (
    contentType === "" ||
    contentType.startsWith("text/html") ||
    contentType.includes("xhtml")
  ) {
    page = await extractHtml(new TextDecoder().decode(bytes), url.toString());
  } else if (contentType.startsWith("text/") || contentType.endsWith("json")) {
    page = { text: new TextDecoder().decode(bytes).trim() };
  } else {
    throw new Error(`${contentType} is not a readable document`);
  }
  const truncated = page.text.length > MAX_FETCH_CHARS;
  return {
    url: url.toString(),
    ...(page.title === undefined ? {} : { title: page.title }),
    text: truncated ? page.text.slice(0, MAX_FETCH_CHARS) : page.text,
    truncated,
  };
}

/** Normalizes a URL into a cache key by removing hash fragments.
 * Unparsable strings are retained as raw keys and rejected during fetch. */
export function fetchCacheKey(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function createWebFetchTool(ctx: RunToolContext, signal: AbortSignal) {
  return tool({
    description: WEB_FETCH_DESCRIPTION,
    inputSchema: webFetchInputSchema,
    execute: async ({ url }): Promise<WebFetchOutput> => {
      if (!ctx.budget.spendFetch()) {
        return { url, text: "", truncated: false, error: FETCH_BUDGET_SPENT };
      }
      const key = fetchCacheKey(url);
      const cached = ctx.caches.fetch.get(key) as WebFetchOutput | undefined;
      if (cached) {
        return cached;
      }
      try {
        const page = await fetchReadablePage(ctx, url, signal);
        ctx.caches.fetch.set(key, page);
        ctx.recordUsage("fetch", 1);
        return page;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn({ url, error: message }, "web_fetch failed");
        return { url, text: "", truncated: false, error: `could not read ${url}: ${message}` };
      }
    },
  });
}
