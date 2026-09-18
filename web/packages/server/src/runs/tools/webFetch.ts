// The owned `web_fetch` tool (`04-agent-runtime.md` §6).
//
// Reads one public page and returns it as text the model can quote. The three
// things that make it safe rather than a proxy for the machine's own network
// are in `ssrf.ts` (address policy), here (redirect re-checking, byte and time
// caps), and in the absence of any credential on the outbound request.

import { tool } from "ai";
import { z } from "zod";

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

/** Reads at most `MAX_FETCH_BYTES`, then stops: a `content-length` header is
 * a claim, and a body without one is unbounded until it is read. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    throw new Error(`the page is larger than ${MAX_FETCH_BYTES} bytes`);
  }
  const body = response.body;
  if (!body) {
    return new Uint8Array(await response.arrayBuffer()).slice(0, MAX_FETCH_BYTES);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as {
      done: boolean;
      value?: Uint8Array | undefined;
    };
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > MAX_FETCH_BYTES) {
        chunks.push(value.slice(0, value.byteLength - (total - MAX_FETCH_BYTES)));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(Math.min(total, MAX_FETCH_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface ExtractedPage {
  title?: string;
  text: string;
}

/**
 * The shapes this module uses out of `linkedom` and `@mozilla/readability`.
 *
 * Both packages type themselves against the DOM library, which this package
 * does not load (it is a Node server; `lib` is ES2022). Rather than pull the
 * whole DOM into the build for three property reads, the two dynamic imports
 * are narrowed to what is actually called.
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

/** HTML to the prose a reader would see. Readability over a `linkedom`
 * document, with a tag-stripping fallback: a page Readability cannot parse
 * (a bare `<pre>`, a framed document) still has text worth quoting. */
export async function extractHtml(html: string, url: string): Promise<ExtractedPage> {
  try {
    const [linkedom, readability] = await Promise.all([
      import("linkedom") as Promise<unknown>,
      import("@mozilla/readability") as Promise<unknown>,
    ]);
    const { parseHTML } = linkedom as { parseHTML: ParseHtml };
    const { Readability } = readability as { Readability: ReadabilityConstructor };
    const { document } = parseHTML(html, { location: url });
    // Readability mutates the document it is given, so the whole-page fallback
    // is taken first: a page it declines to parse would otherwise be read back
    // as the empty body it left behind.
    const title = document.querySelector("title")?.textContent?.trim();
    const bodyText = document.body?.textContent ?? "";
    // A fragment without `<html>`/`<body>` keeps its text on the root element;
    // `linkedom` does not insert the implied tags a browser would.
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

/** One hop at a time so every `Location` passes the address policy before it
 * is followed — a public host that redirects to `127.0.0.1` is the standard
 * way around a guard that only checks the URL it was handed. */
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
    throw new Error(`the server answered ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  const bytes = await readCapped(response);
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

export function createWebFetchTool(ctx: RunToolContext, signal: AbortSignal) {
  return tool({
    description: WEB_FETCH_DESCRIPTION,
    inputSchema: webFetchInputSchema,
    execute: async ({ url }): Promise<WebFetchOutput> => {
      if (!ctx.budget.spendFetch()) {
        return { url, text: "", truncated: false, error: FETCH_BUDGET_SPENT };
      }
      const cached = ctx.caches.fetch.get(url) as WebFetchOutput | undefined;
      if (cached) {
        return cached;
      }
      try {
        const page = await fetchReadablePage(ctx, url, signal);
        ctx.caches.fetch.set(url, page);
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
