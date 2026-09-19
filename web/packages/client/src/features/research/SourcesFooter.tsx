// The Sources footer (`09-research-document-view.md` §7).
//
// Google's grounded search returns a rendered "search entry point" — a chip
// row of the queries it ran — that its terms require to be displayed alongside
// the answer. It is provider-authored HTML, so it goes through DOMPurify
// before it reaches the DOM, with links forced through `safeHref` and opened
// in a new tab.
//
// `style` is deliberately absent from the tag allowlist. A `<style>` block in
// the page is global — it can restyle or cover app chrome, and its selectors
// can probe the document — Disallow <style> tags to prevent external search provider HTML from affecting global application styles.
// The `style` *attribute* stays: it is per element, DOMPurify runs its own CSS
// filter over it, and it is what makes the chips look like chips.

import { safeHref } from "@session/shared";
import type { Turn } from "@session/shared";
import DOMPurify from "dompurify";
import { useMemo } from "react";

import { researchSources } from "./sources.js";

const ENTRY_POINT_CONFIG = {
  ALLOWED_TAGS: ["div", "span", "a", "svg", "path", "g", "img"],
  ALLOWED_ATTR: ["class", "style", "href", "target", "rel", "d", "viewBox", "fill", "src", "alt"],
};

function sanitizeSearchEntryPoint(html: string): string {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName.toLowerCase() !== "a") return;
    const safe = safeHref(node.getAttribute("href"));
    if (!safe) {
      node.removeAttribute("href");
      return;
    }
    node.setAttribute("href", safe);
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  });
  try {
    return DOMPurify.sanitize(html, ENTRY_POINT_CONFIG);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

export function SourcesFooter({ turns }: { turns: readonly Turn[] }) {
  const { sources, searchEntryPoints } = useMemo(() => researchSources(turns), [turns]);
  const entryPoints = useMemo(
    () => searchEntryPoints.map(sanitizeSearchEntryPoint).filter((html) => html.trim() !== ""),
    [searchEntryPoints],
  );

  if (sources.length === 0 && entryPoints.length === 0) return null;

  return (
    <section className="border-border-faint mt-5 border-t pt-3" aria-label="Sources">
      <h2 className="text-fg-subtle m-0 text-xs font-semibold tracking-wide uppercase">Sources</h2>
      {sources.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {sources.map((source) => (
            <li key={source.url} className="flex min-w-0 items-baseline gap-2 text-sm">
              <a
                className="text-fg-secondary hover:text-fg-strong min-w-0 truncate underline-offset-2 hover:underline"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                title={source.url}
              >
                {source.title}
              </a>
              <span className="text-fg-faint shrink-0 text-xs">{source.domain}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {entryPoints.map((html, index) => (
        <div
          key={index}
          className="mt-2"
          // Provider-authored markup, sanitized above; Google's terms require
          // the entry point to be shown as delivered.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ))}
    </section>
  );
}
