// Main Markdown renderer (`08-design-system-and-styling.md` §5).
//
// Everything that renders model-authored prose — a research answer, a recap, a
// feed preview, an encyclopedia page — goes through this component, so the
// parse is identical everywhere and typography is chosen on the renderer
// rather than inherited from whatever layout root the text lands in.
//
// Plugins: the base lists come from `shared/markdown/plugins`, and the math
// lists are swapped in through `useSyncExternalStore` once the lazy chunk
// resolves (`mathPlugins.ts`). Source passes through
// `escapeWikilinkTablePipes` (GFM would otherwise split an aliased wikilink
// into two cells) and, once math is available, `normalizeLatexMathDelimiters`.
//
// Security: `safeHref` validates all link destinations before rendering. Remote images are
// never fetched (`BlockedMarkdownImage`), and the image markers pasted into
// transcripts collapse to an inert `[Image]` chip rather than anything
// navigable. Inline-code file links are recognized but not promoted: the
// artifact store they would open lands in Phase 7.

import { Popover as BasePopover } from "@base-ui/react/popover";
import {
  baseRehypePlugins,
  baseRemarkPlugins,
  collapseImageMarkers,
  escapeWikilinkTablePipes,
  inlineCodeFilePath,
  normalizeLatexMathDelimiters,
  safeHref,
} from "@session/shared";
import { isValidElement, memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

import { cn } from "../../lib/cn.js";
import { ControlButton } from "../../ui/Button.js";
import { POPOVER_SURFACE } from "../../ui/surfaces.js";

import { DiagramBlock, diagramLangFromClassName, nodeText } from "./DiagramBlock.js";
import {
  ensureMathPlugins,
  readMathPlugins,
  sourceMayContainMath,
  subscribeToMathPlugins,
} from "./mathPlugins.js";
import { isOversizedMarkdown, oversizedFallbackText } from "./policy.js";
import type { OversizedMarkdownPolicy } from "./policy.js";
import { useWikilinkActions } from "./wikilinks.js";
import type { WikilinkActions } from "./wikilinks.js";

interface TranscriptHastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  children?: TranscriptHastNode[];
}

const FILE_PATH_DATA_KEY = "sessionInlineFilePath";

function exactTextChild(node: TranscriptHastNode): string | undefined {
  if (node.children?.length !== 1 || node.children[0]?.type !== "text") return undefined;
  return node.children[0].value;
}

/**
 * Marks inline code that names a file, so a later phase can promote it to an
 * artifact link without another pass over the tree. An inline `code` node is
 * distinguishable from fenced output only here: the latter is a child of `pre`,
 * and React's `code` component alone never sees its parent.
 *
 * The desktop's Codex inline-visualization directives and content references
 * are dropped with the native backend they belonged to (09 §9).
 */
export function rehypeTranscriptArtifacts() {
  return (tree: TranscriptHastNode) => {
    const visit = (node: TranscriptHastNode, parent?: TranscriptHastNode) => {
      if (node.type === "element" && node.tagName === "code" && parent?.tagName !== "pre") {
        const text = exactTextChild(node);
        const path = text === undefined ? undefined : inlineCodeFilePath(text);
        if (path) (node.data ??= {})[FILE_PATH_DATA_KEY] = path;
      }
      for (const child of node.children ?? []) visit(child, node);
    };
    visit(tree);
  };
}

const CLIENT_REHYPE_PLUGINS = [...baseRehypePlugins, rehypeTranscriptArtifacts];

function markedValue(node: TranscriptHastNode | undefined, key: string): string | undefined {
  const value = node?.data?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Links in answer prose. A wikilink is checked first because it carries no
 * href: the remark transform marks it with `data-wikilink`, and what activating
 * it does comes from `WikilinkActionsContext`. Everything else is a
 * destination a model wrote, so it renders as a link only if `safeHref`
 * accepts it and always opens in a new tab (07 §9); a rejected destination
 * Render as plain text when the link URL is invalid or empty.
 */
export function MarkdownLink({
  href,
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: TranscriptHastNode }) {
  const wikilinks = useWikilinkActions();
  const term = node?.properties?.["dataWikilink"];

  if (typeof term === "string") {
    return <WikilinkAnchor {...props} term={term} actions={wikilinks} />;
  }

  const { children, ...rest } = props;
  const safe = safeHref(href);
  if (!safe) return <span {...rest}>{children}</span>;
  return (
    <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * A term with a page opens it on click. A term without one asks first: writing
 * a page is a model call, and a stray click on linked text should not start
 * one. The confirmation is a small popover on the link itself, so the reader
 * keeps their place; Enter and a click both open it, and either button or
 * Escape closes it.
 */
function WikilinkAnchor({
  term,
  actions,
  ...props
}: ComponentPropsWithoutRef<"a"> & { term: string; actions: WikilinkActions }) {
  const [confirming, setConfirming] = useState(false);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const status = actions.resolve(term);
  const activate = (element: HTMLElement) => {
    if (!actions.interactive) return;
    if (status === null || status === "failed") {
      setConfirming(true);
      return;
    }
    actions.activate(term, element);
  };
  const create = () => {
    setConfirming(false);
    if (anchorRef.current) actions.activate(term, anchorRef.current);
  };

  return (
    <BasePopover.Root open={confirming} onOpenChange={setConfirming}>
      <a
        {...props}
        ref={anchorRef}
        className={cn(props.className, status ? `is-${status}` : null)}
        role="link"
        tabIndex={0}
        data-wikilink={term}
        title={
          !actions.interactive
            ? undefined
            : status
              ? `Open encyclopedia page: ${term}`
              : `Create encyclopedia page: ${term}`
        }
        onClick={(event) => {
          event.preventDefault();
          activate(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            activate(event.currentTarget);
          }
        }}
      />
      <BasePopover.Portal>
        <BasePopover.Positioner
          anchor={anchorRef}
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-(--z-popover)"
        >
          <BasePopover.Popup
            aria-label={`Create encyclopedia page: ${term}`}
            className={cn(POPOVER_SURFACE, "flex max-w-72 flex-col gap-2.5 rounded-lg p-3")}
          >
            <p className="text-fg-primary m-0 text-sm">
              {status === "failed"
                ? `Couldn’t create the page for “${term}”.`
                : `Create an encyclopedia page for “${term}”?`}
            </p>
            <div className="flex items-center justify-end gap-1.5">
              <ControlButton size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </ControlButton>
              <ControlButton size="sm" className="text-fg-strong" onClick={create}>
                {status === "failed" ? "Retry" : "Create page"}
              </ControlButton>
            </div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

/**
 * Remote images are never fetched (07 §9): a model-authored `src` Block external images to protect privacy and prevent user IP tracking. The alt text
 * stays, and a safe destination becomes a button that opens the image in a new
 * tab on a deliberate click.
 */
export function BlockedMarkdownImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const safe = safeHref(src);
  if (!safe) return alt ? <span>{alt}</span> : null;
  return (
    <a
      className="text-fg-secondary underline underline-offset-2"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
    >
      {alt ? `Open image: ${alt}` : "Open external image"}
    </a>
  );
}

function MarkdownCode({
  node,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & { node?: TranscriptHastNode }) {
  // The marked path is carried on the element so the artifact panel (Phase 7)
  // can find it; it is deliberately not interactive yet.
  const filePath = markedValue(node, FILE_PATH_DATA_KEY);
  return (
    <code {...props} {...(filePath === undefined ? {} : { "data-file-path": filePath })}>
      {children}
    </code>
  );
}

const markdownComponents: Components = {
  a: ({ node, href, ...props }) => (
    <MarkdownLink node={node as TranscriptHastNode | undefined} href={href} {...props} />
  ),
  code: ({ node, children, ...props }) => (
    <MarkdownCode node={node as TranscriptHastNode | undefined} {...props}>
      {children}
    </MarkdownCode>
  ),
  img: (props) => <BlockedMarkdownImage src={props.src} alt={props.alt} title={props.title} />,
  table: (props) => (
    <div className="research-prose-table-wrap">
      <table>{props.children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const codeElement = isValidElement(children)
      ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
      : null;
    const lang = diagramLangFromClassName(codeElement?.props.className);
    if (codeElement && lang) {
      return <DiagramBlock lang={lang} code={nodeText(codeElement.props.children)} />;
    }
    return (
      <div className="research-prose-code-block">
        <pre>{children}</pre>
      </div>
    );
  },
};

// Paragraphs and hard breaks are block boundaries in the source, but an inline
// context (a title, a card preview) needs them to flow as ordinary spaces.
// Inline children are kept so links and emphasis survive; code flattens to
// plain text so a compact preview keeps one type style.
const inlineComponents: Components = {
  ...markdownComponents,
  p: ({ children }) => <span>{children} </span>,
  br: () => <span> </span>,
  code: ({ children }) => <span>{children}</span>,
};

/** Block-level elements whose wrapper is dropped in inline mode (their inline
 * children are kept), so a stray heading or list in a one-line context renders
 * as plain rich text instead of promoting to a block. */
const INLINE_DISALLOWED_ELEMENTS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

export type ResearchMarkdownVariant = "prose" | "summary" | "compact";

export interface ResearchMarkdownProps {
  markdown: string;
  /** `prose` for answers, `summary` for recap text, `compact` for previews. */
  variant?: ResearchMarkdownVariant;
  className?: string;
  /** Strip block wrappers and render on one line. */
  inline?: boolean;
  /** Fall back to preformatted text past a size cap. Callers must pass a
   * stable object or the memo below degrades to identity. */
  oversized?: OversizedMarkdownPolicy;
}

const VARIANT_CLASS: Record<ResearchMarkdownVariant, string> = {
  prose: "research-prose",
  summary: "research-summary-text",
  compact: "research-prose research-prose--compact",
};

/**
 * Memoized because react-markdown re-parses on every render and callers
 * re-render far more often than their text changes — a streaming answer
 * delivers a fresh block object whose `markdown` is value-equal several times a
 * second. Every prop is a primitive except `oversized`, which callers hoist.
 * Wikilink behavior stays live because `MarkdownLink` reads it from context,
 * which the memo does not block.
 */
export const ResearchMarkdown = memo(function ResearchMarkdown({
  markdown,
  variant = "prose",
  className,
  inline = false,
  oversized,
}: ResearchMarkdownProps) {
  const math = useSyncExternalStore(subscribeToMathPlugins, readMathPlugins, readMathPlugins);
  // Collapse pasted-image markers to an inert `[Image]` chip before parsing
  // (`shared/markdown/imageMarkers`).
  const source = escapeWikilinkTablePipes(collapseImageMarkers(markdown));
  // Initialize the math plugin chunk only when the source contains LaTeX delimiters.
  const needsMath = sourceMayContainMath(source);
  useEffect(() => {
    if (needsMath) void ensureMathPlugins();
  }, [needsMath]);

  if (isOversizedMarkdown(source, oversized)) {
    return (
      <pre className={cn(oversized.fallbackClassName ?? "research-plaintext", className)}>
        {oversizedFallbackText(source, oversized)}
      </pre>
    );
  }

  return (
    <div className={cn(VARIANT_CLASS[variant], className)}>
      <ReactMarkdown
        components={inline ? inlineComponents : markdownComponents}
        remarkPlugins={math ? [...baseRemarkPlugins, ...math.remarkPlugins] : baseRemarkPlugins}
        rehypePlugins={
          math ? [...CLIENT_REHYPE_PLUGINS, ...math.rehypePlugins] : CLIENT_REHYPE_PLUGINS
        }
        disallowedElements={inline ? INLINE_DISALLOWED_ELEMENTS : undefined}
        unwrapDisallowed={inline}
      >
        {math ? normalizeLatexMathDelimiters(source) : source}
      </ReactMarkdown>
    </div>
  );
});
