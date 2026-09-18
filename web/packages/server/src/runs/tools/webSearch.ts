// The owned `web_search` tool (`04-agent-runtime.md` §6, §6.1).
//
// One interface, two vendors. Which one is primary is deployment
// configuration, the other is the fallback after an error, and with neither
// key the tool is not registered at all — `runtimeConfig.features.webSearch`
// is false and the composer says so, rather than the model calling a tool that
// always fails.

import { tool } from "ai";
import { z } from "zod";

import type { Config } from "../../config.js";

import type { RunToolContext } from "./context.js";
import { SEARCH_BUDGET_SPENT } from "./context.js";

export const SEARCH_RESULT_COUNT = 10;
const VENDOR_TIMEOUT_MS = 15_000;
/** Vendor excerpts are what the model reads; a whole page belongs in
 * `web_fetch`, so an excerpt that arrives longer than this is cut. */
const MAX_SNIPPET_CHARS = 1_200;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export type SearchRecency = "day" | "week" | "month" | "year";

export interface SearchOptions {
  recency?: SearchRecency | undefined;
  maxResults?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface SearchVendor {
  readonly name: "parallel" | "tavily";
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

function clampSnippet(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_SNIPPET_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_SNIPPET_CHARS)}…`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(VENDOR_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Parallel's Search API: cheapest per query, and its excerpts are already
 * shaped for a model to read. */
export function parallelVendor(apiKey: string, fetchImpl: typeof globalThis.fetch): SearchVendor {
  return {
    name: "parallel",
    async search(query, options) {
      // The API has no recency parameter; the objective is the only place the
      // constraint can be expressed, and it does affect ranking.
      const objective =
        options.recency === undefined ? query : `${query} (prefer the past ${options.recency})`;
      const response = await fetchImpl("https://api.parallel.ai/v1beta/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          objective,
          search_queries: [query],
          processor: "base",
          max_results: options.maxResults ?? SEARCH_RESULT_COUNT,
          max_chars_per_result: MAX_SNIPPET_CHARS,
        }),
        signal: timeoutSignal(options.signal),
      });
      if (!response.ok) {
        throw new Error(`parallel search failed with ${response.status}`);
      }
      const body = (await response.json()) as { results?: unknown[] };
      return (body.results ?? []).flatMap((entry) => {
        const record = entry as Record<string, unknown>;
        const url = asString(record["url"]);
        if (url === "") {
          return [];
        }
        const excerpts = Array.isArray(record["excerpts"]) ? (record["excerpts"] as unknown[]) : [];
        const snippet = clampSnippet(
          excerpts.map(asString).join(" ") || asString(record["excerpt"]),
        );
        const published = asString(record["published_date"] ?? record["publishedAt"]);
        return [
          {
            title: asString(record["title"]) || url,
            url,
            snippet,
            ...(published === "" ? {} : { publishedAt: published }),
          },
        ];
      });
    },
  };
}

/** Tavily: search and cleaned page text in one call, at a higher price. */
export function tavilyVendor(apiKey: string, fetchImpl: typeof globalThis.fetch): SearchVendor {
  return {
    name: "tavily",
    async search(query, options) {
      const response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          max_results: options.maxResults ?? SEARCH_RESULT_COUNT,
          search_depth: "basic",
          include_raw_content: "markdown",
          ...(options.recency === undefined ? {} : { time_range: options.recency }),
        }),
        signal: timeoutSignal(options.signal),
      });
      if (!response.ok) {
        throw new Error(`tavily search failed with ${response.status}`);
      }
      const body = (await response.json()) as { results?: unknown[] };
      return (body.results ?? []).flatMap((entry) => {
        const record = entry as Record<string, unknown>;
        const url = asString(record["url"]);
        if (url === "") {
          return [];
        }
        const published = asString(record["published_date"]);
        return [
          {
            title: asString(record["title"]) || url,
            url,
            snippet: clampSnippet(asString(record["content"])),
            ...(published === "" ? {} : { publishedAt: published }),
          },
        ];
      });
    },
  };
}

/** Primary first, then the other one. Empty when the deployment has no search
 * key, which is what makes the tool absent rather than broken. */
export function searchVendors(config: Config, fetchImpl: typeof globalThis.fetch): SearchVendor[] {
  const byName = new Map<string, SearchVendor>();
  if (config.search.parallelApiKey !== null) {
    byName.set("parallel", parallelVendor(config.search.parallelApiKey, fetchImpl));
  }
  if (config.search.tavilyApiKey !== null) {
    byName.set("tavily", tavilyVendor(config.search.tavilyApiKey, fetchImpl));
  }
  const primary = byName.get(config.search.vendor);
  const rest = [...byName.values()].filter((vendor) => vendor !== primary);
  return primary ? [primary, ...rest] : rest;
}

function cacheKey(query: string, recency: string | undefined): string {
  return `${recency ?? "any"}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(400).describe("The search query."),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Restrict results to roughly this recent."),
});

export interface WebSearchOutput {
  results: SearchResult[];
  error?: string;
}

export const WEB_SEARCH_DESCRIPTION =
  "Search the web and return ranked results with short excerpts. Use it to find sources " +
  "rather than answering from memory, then read the ones you rely on with web_fetch. " +
  "Cite what you use as inline Markdown links. Stop searching once the question is answered.";

/**
 * The tool, or `null` when the deployment has no search vendor.
 *
 * The vendors are tried in order on an error, so one vendor's outage costs a
 * run a slower first search rather than its sources. An error from every
 * vendor is returned as a tool result: the model continues with `web_fetch`
 * and whatever it already has.
 */
export function createWebSearchTool(ctx: RunToolContext, signal: AbortSignal) {
  const vendors = searchVendors(ctx.config, ctx.fetch);
  if (vendors.length === 0) {
    return null;
  }
  return tool({
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: webSearchInputSchema,
    execute: async ({ query, recency }): Promise<WebSearchOutput> => {
      if (!ctx.budget.spendSearch()) {
        return { results: [], error: SEARCH_BUDGET_SPENT };
      }
      const key = cacheKey(query, recency);
      const cached = ctx.caches.search.get(key) as SearchResult[] | undefined;
      if (cached) {
        return { results: cached };
      }
      const failures: string[] = [];
      for (const vendor of vendors) {
        try {
          const results = (
            await vendor.search(query, {
              recency,
              maxResults: SEARCH_RESULT_COUNT,
              signal,
            })
          ).slice(0, SEARCH_RESULT_COUNT);
          ctx.caches.search.set(key, results);
          ctx.recordUsage("search", 1);
          return { results };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${vendor.name}: ${message}`);
          ctx.logger.warn(
            { vendor: vendor.name, query, error: message },
            "web_search vendor error",
          );
        }
      }
      return { results: [], error: `search is unavailable right now (${failures.join("; ")})` };
    },
  });
}
