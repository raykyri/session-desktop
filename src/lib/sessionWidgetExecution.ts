// Execution choices are shared by the static/run URLs and expanded copies of
// the same widget. A containment stop revokes remembered execution everywhere.
import type { ResearchWidgetUrls } from "./api";

type WidgetExecution = "running" | "focus" | null;
const choices = new Map<string, Exclude<WidgetExecution, null>>();
const listeners = new Set<() => void>();
const staticPages = new Set<string>();

function pageAddress(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** The backend's capability URLs carry random tokens, not a public mode flag.
 * Remember which URL is inert so a stopped widget can still be read expanded. */
export function registerWidgetUrls(urls: ResearchWidgetUrls): ResearchWidgetUrls {
  if (sessionWidgetIdentity(urls.staticUrl)) staticPages.add(pageAddress(urls.staticUrl));
  return urls;
}

export function isStaticWidgetPage(url: string): boolean {
  return sessionWidgetIdentity(url) !== null && staticPages.has(pageAddress(url));
}

export function sessionWidgetIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = /^\/__session\/widget\/[a-f0-9]{64}\/([a-f0-9]{64})\.html$/.exec(parsed.pathname);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && match
      ? `${parsed.origin}/${match[1]}`
      : null;
  } catch {
    return null;
  }
}

export function readWidgetExecution(url: string | null | undefined): WidgetExecution {
  const key = sessionWidgetIdentity(url);
  return key ? choices.get(key) ?? null : null;
}

export function rememberWidgetExecution(url: string, choice: Exclude<WidgetExecution, null>) {
  const key = sessionWidgetIdentity(url);
  if (!key || choices.get(key) === choice) return;
  choices.set(key, choice);
  for (const listener of listeners) listener();
}

export function subscribeWidgetExecution(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
