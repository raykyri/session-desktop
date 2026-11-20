// The Markdown renderer for answers (phase 2b): the shared parse
// (`shared/markdown/plugins`, math loaded when the text has LaTeX), safe
// links, no remote images, and no widgets (AGENTS.md: the spaces client has
// none, so a `session-html` block is ordinary code; diagrams are code too).
//
// Citations: an answer cites a source with a link whose text is its number,
// `[3](https://example.org/page "Title")`. It renders as the mockup's
// citation marker (`<sup class="cite">3</sup>`), and `citationsOf` lists the
// sources in number order for the thread's Sources list.

import {
  baseRehypePlugins,
  baseRemarkPlugins,
  collapseImageMarkers,
  escapeWikilinkTablePipes,
  normalizeLatexMathDelimiters,
  safeHref,
} from "@session/shared";
import { memo, useEffect, useSyncExternalStore, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import {
  ensureMathPlugins,
  readMathPlugins,
  sourceMayContainMath,
  subscribeToMathPlugins,
} from "./mathPlugins.js";
import {
  isOversizedMarkdown,
  oversizedFallbackText,
  OVERSIZED_MARKDOWN_POLICY,
  type OversizedMarkdownPolicy,
} from "./policy.js";

/** A cited source: its number, title and address. */
export interface Citation {
  n: number;
  title: string;
  href: string;
  host: string;
}

const CITE = /\[(\d{1,3})\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g;

export const hostOf = (href: string) => {
  try {
    return new URL(href).host.replace(/^www\./, "");
  } catch {
    return href.replace(/^https?:\/\//, "").split("/")[0] ?? href;
  }
};

/** The sources an answer cites, by number (the first link of each number). */
export function citationsOf(markdown: string | null | undefined): Citation[] {
  const by = new Map<number, Citation>();
  for (const m of (markdown ?? "").matchAll(CITE)) {
    const n = Number(m[1]);
    const href = m[2] ?? "";
    if (by.has(n) || !safeHref(href)) continue;
    const host = hostOf(href);
    by.set(n, { n, href, host, title: m[3] || host });
  }
  return [...by.values()].sort((a, b) => a.n - b.n);
}

function MarkdownLink({
  href,
  node,
  children,
  title,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  void node;
  const safe = safeHref(href);
  const text =
    typeof children === "string"
      ? children
      : Array.isArray(children) && children.length === 1 && typeof children[0] === "string"
        ? children[0]
        : null;
  if (safe && text !== null && /^\d{1,3}$/.test(text))
    return (
      <sup
        className="cite ta-cite"
        tabIndex={0}
        // the mockup's citation marker: a superscript that opens its source
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
        role="button"
        aria-label={`Source ${text}`}
        title={title ?? hostOf(safe)}
      >
        {text}
      </sup>
    );
  if (!safe) return <span>{children}</span>;
  return (
    <a
      {...rest}
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      {...(title ? { title } : {})}
    >
      {children}
    </a>
  );
}

/** Remote images are never fetched: the alt text, or a link to open it. */
function BlockedImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const safe = typeof src === "string" ? safeHref(src) : null;
  if (!safe) return alt ? <span>{alt}</span> : null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {alt ? `Open image: ${alt}` : "Open external image"}
    </a>
  );
}

const components: Components = {
  a: MarkdownLink,
  img: BlockedImage,
};

export interface MarkdownProps {
  markdown: string;
  className?: string;
  oversized?: OversizedMarkdownPolicy;
}

/** Memoized: a streaming answer renders again several times a second with
 * the same text. */
export const Markdown = memo(function Markdown({
  markdown,
  className,
  oversized = OVERSIZED_MARKDOWN_POLICY,
}: MarkdownProps) {
  const math = useSyncExternalStore(subscribeToMathPlugins, readMathPlugins, readMathPlugins);
  const source = escapeWikilinkTablePipes(collapseImageMarkers(markdown));
  const needsMath = sourceMayContainMath(source);
  useEffect(() => {
    if (needsMath) void ensureMathPlugins();
  }, [needsMath]);
  if (isOversizedMarkdown(source, oversized))
    return <pre className={className}>{oversizedFallbackText(source, oversized)}</pre>;
  return (
    <div className={className}>
      <ReactMarkdown
        components={components}
        remarkPlugins={math ? [...baseRemarkPlugins, ...math.remarkPlugins] : baseRemarkPlugins}
        rehypePlugins={math ? [...baseRehypePlugins, ...math.rehypePlugins] : baseRehypePlugins}
      >
        {math ? normalizeLatexMathDelimiters(source) : source}
      </ReactMarkdown>
    </div>
  );
});
