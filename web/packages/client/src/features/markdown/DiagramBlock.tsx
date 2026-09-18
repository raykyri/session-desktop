// Fenced ```mermaid and ```dot / ```graphviz blocks, rendered to SVG in the
// tab (`08-design-system-and-styling.md` §5, `07-client-architecture.md` §9).
//
// Both engines are dynamically imported, so they land in their own chunk and
// only load once a diagram scrolls into view. Diagram source is model-authored
// and the rendered SVG is injected with `dangerouslySetInnerHTML`, so it goes
// through DOMPurify's SVG profile with an `afterSanitizeAttributes` hook that
// routes anchor destinations through `safeHref` and keeps every non-anchor
// reference local. On any failure the raw source is shown, so no content is
// lost.

import { safeHref } from "@session/shared";
import DOMPurify from "dompurify";
import { isValidElement, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";

import { openDiagramLightbox } from "../../stores/lightboxes.js";
import { ControlButton } from "../../ui/Button.js";

export type DiagramLang = "mermaid" | "dot";

/** Maps a fenced block's info string (react-markdown hands it over as
 * `language-xxx`) to the engine that should draw it, or null for ordinary
 * code. */
export function diagramLangFromClassName(className?: string): DiagramLang | null {
  if (!className) return null;
  const match = /language-([\w-]+)/.exec(className);
  const lang = match?.[1]?.toLowerCase();
  if (lang === "mermaid") return "mermaid";
  if (lang === "dot" || lang === "graphviz" || lang === "gv") return "dot";
  return null;
}

/** Flattens the react-markdown children of a `<code>` element back to source. */
export function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => nodeText(child as ReactNode)).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

type DocumentAppearance = "dark" | "light";

function documentAppearance(): DocumentAppearance {
  return typeof document !== "undefined" &&
    document.documentElement.dataset["appearance"] === "light"
    ? "light"
    : "dark";
}

/** Tracks `data-appearance` on `<html>` so a diagram redraws in the matching
 * palette instead of keeping the one it was first drawn with. */
function useDocumentAppearance(): DocumentAppearance {
  const [appearance, setAppearance] = useState<DocumentAppearance>(documentAppearance);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setAppearance(documentAppearance()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-appearance"],
    });
    // The attribute may already have changed between the initial read and the
    // observer being attached; this closes that window.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAppearance(documentAppearance());
    return () => observer.disconnect();
  }, []);
  return appearance;
}

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidTheme: DocumentAppearance | null = null;

function getMermaid(appearance: DocumentAppearance): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((module) => module.default as unknown as MermaidApi);
  return mermaidPromise.then((api) => {
    if (mermaidTheme !== appearance) {
      // `initialize` replaces the config wholesale, so every option is restated.
      api.initialize({
        startOnLoad: false,
        theme: appearance === "light" ? "neutral" : "dark",
        securityLevel: "strict",
        // Sanitizing strips `<foreignObject>`, so labels must be plain SVG
        // `<text>` or flowchart labels disappear entirely.
        htmlLabels: false,
        themeVariables: { fontFamily: "var(--font-ui)" },
      });
      mermaidTheme = appearance;
    }
    return api;
  });
}

interface Viz {
  renderString: (source: string, options?: { format?: string }) => string;
}

let vizPromise: Promise<Viz> | null = null;

function getViz(): Promise<Viz> {
  vizPromise ??= import("@viz-js/viz").then(
    (module) => module.instance() as unknown as Promise<Viz>,
  );
  return vizPromise;
}

const DIAGRAM_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_ATTR: ["data-session-href"],
};

export function diagramSanitizerHook(node: Element): void {
  // `href` and the namespaced `xlink:href` both surface with local name "href".
  const hrefAttributes = Array.from(node.attributes).filter(
    (attribute) => attribute.localName.toLowerCase() === "href",
  );
  if (hrefAttributes.length === 0) return;
  if (node.nodeName.toLowerCase() === "a") {
    const raw = hrefAttributes
      .map((attribute) => attribute.value)
      .find((value) => value.trim() !== "");
    for (const attribute of hrefAttributes) node.removeAttributeNode(attribute);
    const safe = safeHref(raw);
    if (safe) {
      node.setAttribute("data-session-href", safe);
      node.setAttribute("href", "#");
    }
    return;
  }
  // Non-anchor element: keep only local (`#id`) references, so an injected
  // paint server, `use` or `image` cannot fetch a remote resource.
  for (const attribute of hrefAttributes) {
    if (!attribute.value.trim().startsWith("#")) node.removeAttributeNode(attribute);
  }
}

export function sanitizeDiagramSvg(svg: string): string {
  DOMPurify.addHook("afterSanitizeAttributes", diagramSanitizerHook);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(svg, DIAGRAM_SANITIZE_CONFIG);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
  if (!clean.trim()) throw new Error("the diagram renderer returned invalid SVG");
  return clean;
}

// Layout runs synchronously on the main thread and neither DOMPurify nor
// Mermaid's strict mode bounds algorithmic cost, so a dense graph well under
// the 100k-character Markdown cap can still stall the tab. Reject an
// over-budget graph before layout and an over-budget SVG before insertion.
const MAX_DIAGRAM_SOURCE_CHARS = 20_000;
const MAX_DIAGRAM_STATEMENTS = 500;
const MAX_DIAGRAM_SVG_CHARS = 2_000_000;

function assertDiagramWithinLimits(code: string): void {
  if (code.length > MAX_DIAGRAM_SOURCE_CHARS) {
    throw new Error(
      `diagram source exceeds the ${MAX_DIAGRAM_SOURCE_CHARS.toLocaleString()}-character limit`,
    );
  }
  let statements = 0;
  for (const line of code.split("\n")) {
    if (line.trim() === "") continue;
    statements += 1;
    if (statements > MAX_DIAGRAM_STATEMENTS) {
      throw new Error(
        `diagram exceeds the ${MAX_DIAGRAM_STATEMENTS.toLocaleString()}-statement limit`,
      );
    }
  }
}

function assertRenderedSvgWithinLimits(svg: string): string {
  if (svg.length > MAX_DIAGRAM_SVG_CHARS) {
    throw new Error(
      `the rendered diagram exceeds the ${MAX_DIAGRAM_SVG_CHARS.toLocaleString()}-character limit`,
    );
  }
  return svg;
}

let mermaidSequence = 0;

async function renderDiagram(
  lang: DiagramLang,
  code: string,
  appearance: DocumentAppearance,
): Promise<string> {
  assertDiagramWithinLimits(code);
  if (lang === "mermaid") {
    const mermaid = await getMermaid(appearance);
    mermaidSequence += 1;
    const { svg } = await mermaid.render(`session-mermaid-${mermaidSequence}`, code);
    return sanitizeDiagramSvg(assertRenderedSvgWithinLimits(svg));
  }
  const viz = await getViz();
  return sanitizeDiagramSvg(
    assertRenderedSvgWithinLimits(viz.renderString(code, { format: "svg" })),
  );
}

/** Defers the work until the block is near the viewport, so a long transcript
 * does not build every diagram — or fetch the engines — up front. */
function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      // No observer to subscribe to: render immediately rather than never.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, inView]);
  return inView;
}

type RenderState =
  { status: "loading" } | { status: "done"; svg: string } | { status: "error"; error: string };

function diagramLinkFromEvent(event: ReactMouseEvent<HTMLElement>): string | null {
  const target = event.target instanceof Element ? event.target : null;
  const href = target?.closest("a[data-session-href]")?.getAttribute("data-session-href");
  return safeHref(href) ?? null;
}

export function DiagramBlock({ lang, code }: { lang: DiagramLang; code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "loading" });
  const [showSource, setShowSource] = useState(false);
  const inView = useInView(containerRef);
  const appearance = useDocumentAppearance();
  const source = code.replace(/\n+$/, "");

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    // Entering the loading state is the effect's own announcement that the
    // previous SVG no longer describes this source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" });
    renderDiagram(lang, source, appearance)
      .then((svg) => {
        if (!cancelled) setState({ status: "done", svg });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inView, lang, source, appearance]);

  const label = lang === "dot" ? "graphviz" : "mermaid";

  return (
    <div className="research-diagram" ref={containerRef} data-lang={lang}>
      <div className="research-diagram-bar">
        <span className="research-diagram-lang">{label}</span>
        <ControlButton size="sm" onClick={() => setShowSource((current) => !current)}>
          {showSource ? "Diagram" : "Source"}
        </ControlButton>
      </div>
      {showSource ? (
        <pre className="research-diagram-source">
          <code>{source}</code>
        </pre>
      ) : state.status === "error" ? (
        <div className="text-fg-muted p-2 text-sm">
          <div>
            Couldn’t render the {label} diagram: {state.error}
          </div>
          <pre className="research-diagram-source">
            <code>{source}</code>
          </pre>
        </div>
      ) : state.status === "done" ? (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          className="research-diagram-svg"
          data-lang={lang}
          onClick={(event) => {
            const href = diagramLinkFromEvent(event);
            if (!href) {
              // A plain click expands the diagram. The SVG is already rendered
              // and sanitized, so the lightbox reuses these exact bytes.
              openDiagramLightbox({ lang, label, svg: state.svg });
              return;
            }
            event.preventDefault();
            window.open(href, "_blank", "noopener,noreferrer");
          }}
          onAuxClick={(event) => {
            // The injected anchors carry an inert href, but suppress auxiliary
            // navigation explicitly so a middle click cannot navigate the tab.
            if (diagramLinkFromEvent(event)) event.preventDefault();
          }}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <div className="text-fg-muted p-2 text-sm">Rendering the {label} diagram…</div>
      )}
    </div>
  );
}
