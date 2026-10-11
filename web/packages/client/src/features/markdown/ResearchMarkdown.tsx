// Main Markdown renderer (`08-design-system-and-styling.md` §5).
//
// Everything that renders model-authored prose — a research answer, a recap, a
// feed preview — goes through this component, so the
// parse is identical everywhere and typography is chosen on the renderer
// rather than inherited from the layout root that contains the text.
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
// artifact store they would open is implemented in Phase 7.

import {
  isSessionWidgetClassName,
  MAX_SESSION_WIDGET_BYTES,
  remarkSessionWidgetFences,
  sessionWidgetByteLength,
  sessionWidgetMetadata,
  baseRehypePlugins,
  baseRemarkPlugins,
  collapseImageMarkers,
  escapeWikilinkTablePipes,
  inlineCodeFilePath,
  normalizeLatexMathDelimiters,
  safeHref,
} from "@session/shared";
import {
  createContext,
  useContext,
  isValidElement,
  memo,
  useEffect,
  useSyncExternalStore,
} from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

import { cn } from "../../lib/cn.js";

import { DiagramBlock, diagramLangFromClassName, nodeText } from "./DiagramBlock.js";
import { SessionWidget } from "./SessionWidget.js";
import {
  ensureMathPlugins,
  readMathPlugins,
  sourceMayContainMath,
  subscribeToMathPlugins,
} from "./mathPlugins.js";
import { isOversizedMarkdown, oversizedFallbackText } from "./policy.js";
import type { OversizedMarkdownPolicy } from "./policy.js";

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

/** Safe external links in answer prose. */
export function MarkdownLink({
  href,
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: TranscriptHastNode }) {
  // The renderer AST is not a DOM attribute.
  void node;
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

const WidgetContext = createContext(false);
function WidgetBlock({
  code,
  state,
  meta,
  children,
}: {
  code: string;
  state: unknown;
  meta: string;
  children: ReactNode;
}) {
  const enabled = useContext(WidgetContext);
  const html = code.endsWith("\n") ? code.slice(0, -1) : code;
  const complete = state === "complete";
  const withinLimit = sessionWidgetByteLength(html) <= MAX_SESSION_WIDGET_BYTES;
  if (enabled && complete && withinLimit)
    return (
      <SessionWidget
        key={html}
        html={html}
        title={sessionWidgetMetadata(meta).title ?? "Answer widget"}
      />
    );
  return (
    <div data-research-widget="" className="research-prose-code-block">
      {enabled ? (
        <p className="text-fg-muted text-xs">
          {complete
            ? "Widget exceeds the 64 KiB preview limit"
            : "Widget preview awaits a complete closing fence"}
        </p>
      ) : null}
      <pre>{children}</pre>
    </div>
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
    if (codeElement && isSessionWidgetClassName(codeElement.props.className)) {
      const props = codeElement.props as Record<string, unknown>;
      return (
        <WidgetBlock
          code={nodeText(codeElement.props.children)}
          state={props["data-session-widget"]}
          meta={
            typeof props["data-session-widget-meta"] === "string"
              ? props["data-session-widget-meta"]
              : ""
          }
        >
          {children}
        </WidgetBlock>
      );
    }
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
  code: ({ children, className }) =>
    isSessionWidgetClassName(className) ? null : <span>{children}</span>,
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
  widgets?: boolean;
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
 */
export const ResearchMarkdown = memo(function ResearchMarkdown({
  markdown,
  widgets = false,
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
    <WidgetContext.Provider value={widgets && !inline && variant === "prose"}>
      <div className={cn(VARIANT_CLASS[variant], className)}>
        <ReactMarkdown
          components={inline ? inlineComponents : markdownComponents}
          remarkPlugins={
            math
              ? [...baseRemarkPlugins, ...math.remarkPlugins, remarkSessionWidgetFences]
              : [...baseRemarkPlugins, remarkSessionWidgetFences]
          }
          rehypePlugins={
            math ? [...CLIENT_REHYPE_PLUGINS, ...math.rehypePlugins] : CLIENT_REHYPE_PLUGINS
          }
          disallowedElements={inline ? INLINE_DISALLOWED_ELEMENTS : undefined}
          unwrapDisallowed={inline}
        >
          {math ? normalizeLatexMathDelimiters(source) : source}
        </ReactMarkdown>
      </div>
    </WidgetContext.Provider>
  );
});
