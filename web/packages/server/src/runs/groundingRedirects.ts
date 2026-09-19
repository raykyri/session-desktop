// Google Search grounding cites pages through opaque redirect links on
// `vertexaisearch.cloud.google.com` (`04-agent-runtime.md` §6.2). Stored as
// they arrive, those links are what the Sources footer, the timeline, a copied
// answer and every later context window would carry. Each one answers a HEAD
// with a 302 to the page it stands for, so the run resolves them before the
// mapper commits the step that cites them, and the redirect link never reaches
// the database or the client.
//
// Only Google's fixed host is contacted, and only its `Location` header is
// read; the page it names is not fetched here, so the address policy in
// `tools/ssrf.ts` does not apply. A link that cannot be resolved in time is
// kept as it came: a redirect the user can still follow beats a dropped source.

import type { TextStreamPart, ToolSet } from "ai";

import type { Logger } from "../logger.js";

export const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PATH = "/grounding-api-redirect/";

/** One HEAD to Google; a slow answer keeps the redirect link rather than
 * stalling the stream. */
const RESOLVE_TIMEOUT_MS = 4_000;

/** Google has only ever answered with the destination itself; the bound is
 * there so a chain of its own redirects cannot loop. */
const MAX_HOPS = 3;

export function isGroundingRedirectUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === GROUNDING_REDIRECT_HOST &&
    url.pathname.startsWith(GROUNDING_REDIRECT_PATH)
  );
}

export interface GroundingRedirectResolver {
  /** The page a grounding redirect stands for, or the input unchanged when it
   * is not a grounding redirect or could not be resolved. */
  resolve(url: string): Promise<string>;
}

export interface ResolverOptions {
  fetch: typeof globalThis.fetch;
  logger: Logger;
  /** The run's signal: an abandoned run stops resolving. */
  signal?: AbortSignal;
}

/** A resolver for one run. Results are memoized so a page cited in several
 * steps, or by both a `source` part and the step's grounding metadata, costs
 * one request. */
export function createGroundingRedirectResolver(
  options: ResolverOptions,
): GroundingRedirectResolver {
  const cache = new Map<string, Promise<string>>();

  const follow = async (start: string): Promise<string> => {
    let url = start;
    for (let hop = 0; hop < MAX_HOPS && isGroundingRedirectUrl(url); hop += 1) {
      const signals = [AbortSignal.timeout(RESOLVE_TIMEOUT_MS)];
      if (options.signal) {
        signals.push(options.signal);
      }
      const response = await options.fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || location === null) {
        return start;
      }
      url = new URL(location, url).toString();
    }
    return isGroundingRedirectUrl(url) ? start : url;
  };

  return {
    resolve(url) {
      if (!isGroundingRedirectUrl(url)) {
        return Promise.resolve(url);
      }
      const cached = cache.get(url);
      if (cached) {
        return cached;
      }
      const pending = follow(url).catch((error: unknown) => {
        options.logger.warn({ error, url }, "grounding redirect could not be resolved");
        return url;
      });
      cache.set(url, pending);
      return pending;
    },
  };
}

// Every field Vertex sends is optional *and* nullable (`mapper.ts`).
interface GroundingChunk {
  web?: { uri?: string | null; title?: string | null } | null;
}

/**
 * The same part with every grounding redirect replaced by the page it stands
 * for: the `url` of a `source` part, and each `groundingChunks[].web.uri` in a
 * step's Google metadata. Parts that cite nothing come back as they were, so
 * the stream's hot path (text deltas) pays only for the check.
 */
export async function resolveGroundingRedirects(
  part: TextStreamPart<ToolSet>,
  resolver: GroundingRedirectResolver,
): Promise<TextStreamPart<ToolSet>> {
  if (part.type === "source") {
    if (part.sourceType !== "url" || !isGroundingRedirectUrl(part.url)) {
      return part;
    }
    return { ...part, url: await resolver.resolve(part.url) };
  }
  if (part.type !== "finish-step") {
    return part;
  }
  const metadata = part.providerMetadata;
  const google = metadata?.["google"];
  const grounding = google?.["groundingMetadata"];
  if (typeof grounding !== "object" || grounding === null || Array.isArray(grounding)) {
    return part;
  }
  const chunks = (grounding as { groundingChunks?: GroundingChunk[] | null }).groundingChunks;
  if (!Array.isArray(chunks)) {
    return part;
  }
  const cited = chunks.some(
    (chunk) => typeof chunk.web?.uri === "string" && isGroundingRedirectUrl(chunk.web.uri),
  );
  if (!cited) {
    return part;
  }
  const resolved = await Promise.all(
    chunks.map(async (chunk) => {
      const uri = chunk.web?.uri;
      if (typeof uri !== "string" || !isGroundingRedirectUrl(uri)) {
        return chunk;
      }
      return { ...chunk, web: { ...chunk.web, uri: await resolver.resolve(uri) } };
    }),
  );
  const providerMetadata = {
    ...metadata,
    google: {
      ...google,
      groundingMetadata: { ...grounding, groundingChunks: resolved },
    },
  } as unknown as typeof metadata;
  return { ...part, providerMetadata };
}
