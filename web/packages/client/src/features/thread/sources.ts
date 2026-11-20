// The Sources footer under an answer (`09-research-document-view.md` §7).
//
// New on the web: the desktop's agents cited inside their prose and nowhere
// else, while the owned tools here record exactly which pages a run read.
// This footer derives its list from the turns themselves, so it stays
// consistent with whatever the transcript shows — including the full-trace
// view, where the same tool results are visible as disclosures.
//
// Three shapes are read, all produced by the server (`04-agent-runtime.md` §6
// and `runs/mapper.ts`):
//
//   web_search   → `{ results: [{ title, url, snippet }], error? }`
//   web_fetch    → `{ url, title?, text, truncated, error? }`
//   google_search→ `{ results: [{ url, title }], searchEntryPoint? }`, a
//                  synthetic block the mapper builds from Gemini's grounding
//                  metadata. Google's terms require the rendered search entry
//                  point to be displayed, so it is carried here and sanitized
//                  before it reaches the DOM.

import { safeHref } from "@session/shared";
import type { Turn } from "@session/shared";

export interface ResearchSource {
  url: string;
  title: string;
  domain: string;
  /** True when the page was actually read rather than only listed. */
  fetched: boolean;
}

export interface ResearchSourceList {
  sources: ResearchSource[];
  /** Google's rendered search entry point, unsanitized. The component
   * sanitizes it; keeping this module DOM-free keeps it testable. */
  searchEntryPoints: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Fetched page titles take precedence over search snippets. Unsafe URLs are filtered out to prevent link-based attacks.
 */
export function researchSources(turns: readonly Turn[]): ResearchSourceList {
  const byUrl = new Map<string, ResearchSource>();
  const searchEntryPoints: string[] = [];

  const add = (rawUrl: unknown, rawTitle: unknown, fetched: boolean) => {
    const url = safeHref(rawUrl);
    if (!url) return;
    const named = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : null;
    const existing = byUrl.get(url);
    if (existing) {
      // A fetch promotes the row, but an untitled fetch of a page search
      // already named must not replace that name with a bare domain.
      if (fetched && !existing.fetched) {
        byUrl.set(url, { ...existing, title: named ?? existing.title, fetched: true });
      }
      return;
    }
    byUrl.set(url, { url, title: named ?? domainOf(url), domain: domainOf(url), fetched });
  };

  // Tool results arrive in later turns than the calls they answer, so the
  // call's name is looked up by its id rather than assumed from position.
  const toolNameById = new Map<string, string>();
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type === "toolUse" && block.id) toolNameById.set(block.id, block.name);
    }
  }

  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type !== "toolResult" || block.isError) continue;
      const name = block.toolUseId ? toolNameById.get(block.toolUseId) : undefined;
      const content = record(block.content);
      if (!content) continue;
      if (name === "web_fetch") {
        add(content["url"], content["title"], true);
        continue;
      }
      if (name === "web_search" || name === "google_search") {
        const entryPoint = stringField(content, "searchEntryPoint");
        if (entryPoint && !searchEntryPoints.includes(entryPoint)) {
          searchEntryPoints.push(entryPoint);
        }
        const results = content["results"];
        if (!Array.isArray(results)) continue;
        for (const result of results) {
          const entry = record(result);
          if (entry) add(entry["url"], entry["title"], false);
        }
      }
    }
  }

  return { sources: [...byUrl.values()], searchEntryPoints };
}
