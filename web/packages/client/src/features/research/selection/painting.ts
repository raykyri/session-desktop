// Painting saved passages (`09-research-document-view.md` §5 item 7).
//
// The CSS Custom Highlight API paints ranges with no DOM of its own, which is
// the only way to tint text that a Markdown renderer owns without rewriting
// its tree — and the only way to tint a passage that crosses element
// boundaries. Four named layers stack:
//
//   session-research-highlights          saved highlights
//   session-research-query-anchors       passages a follow-up was asked about
//   session-research-highlight-overlaps  where those two stack (priority 1)
//   session-research-selected-highlights the selection's own tone (priority 2)
//
// The `Highlight` objects are created once and mutated rather than replaced:
// WebKit fails to visually clear a removed range until the `Highlight` object
// itself is mutated, so replacing it wholesale would leave stale paint behind.
//
// Firefox before 140 has no registry. There, saved highlights — and only those;
// the transient layers repaint far too often to pay for it — fall back to a
// painted layer behind the text (`paintFallbackMarks`).

export const RESEARCH_HIGHLIGHT_LAYER = "session-research-highlights";
export const RESEARCH_QUERY_ANCHOR_LAYER = "session-research-query-anchors";
export const RESEARCH_OVERLAP_LAYER = "session-research-highlight-overlaps";
export const RESEARCH_SELECTED_LAYER = "session-research-selected-highlights";

const OVERLAP_PRIORITY = 1;
const SELECTED_PRIORITY = 2;

export type ResearchHighlightLayer =
  | typeof RESEARCH_HIGHLIGHT_LAYER
  | typeof RESEARCH_QUERY_ANCHOR_LAYER
  | typeof RESEARCH_OVERLAP_LAYER
  | typeof RESEARCH_SELECTED_LAYER;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface NativeHighlight {
  add(range: Range): void;
  clear(): void;
  priority: number;
}

interface HighlightApi {
  registry: HighlightRegistry;
  Highlight: new () => NativeHighlight;
}

export function researchHighlightApi(): HighlightApi | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: unknown }).Highlight;
  if (!css?.highlights || typeof Highlight !== "function") return null;
  return { registry: css.highlights, Highlight: Highlight as new () => NativeHighlight };
}

/** Whether painted passages are tinted by the browser rather than wrapped. The
 * capture path works either way; only the paint differs. */
export function supportsHighlightApi(): boolean {
  return researchHighlightApi() !== null;
}

const PRIORITY: Partial<Record<ResearchHighlightLayer, number>> = {
  [RESEARCH_OVERLAP_LAYER]: OVERLAP_PRIORITY,
  [RESEARCH_SELECTED_LAYER]: SELECTED_PRIORITY,
};

/**
 * The four layers, created once per mounted document and mutated thereafter.
 * `dispose` removes them from the (page-global) registry, so leaving the
 * document leaves no paint behind.
 */
export class ResearchHighlightPainter {
  readonly #api = researchHighlightApi();
  readonly #layers = new Map<ResearchHighlightLayer, NativeHighlight>();

  get supported(): boolean {
    return this.#api !== null;
  }

  #layer(name: ResearchHighlightLayer): NativeHighlight | null {
    const api = this.#api;
    if (!api) return null;
    let layer = this.#layers.get(name);
    if (!layer) {
      layer = new api.Highlight();
      const priority = PRIORITY[name];
      if (priority !== undefined) layer.priority = priority;
      this.#layers.set(name, layer);
      api.registry.set(name, layer);
    }
    return layer;
  }

  paint(name: ResearchHighlightLayer, ranges: readonly Range[]): void {
    const layer = this.#layer(name);
    if (!layer) return;
    layer.clear();
    for (const range of ranges) layer.add(range);
  }

  dispose(): void {
    const api = this.#api;
    for (const [name, layer] of this.#layers) {
      layer.clear();
      api?.registry.delete(name);
    }
    this.#layers.clear();
  }
}

const MARK_ATTRIBUTE = "data-research-highlight-layer";

let fallbackPainting = false;

/** True while the fallback layer is being rebuilt, so the mutation observer
 * that triggers repaints ignores its own work. */
export function isFallbackPainting(): boolean {
  return fallbackPainting;
}

/**
 * The fallback's own layer: one absolutely positioned element appended after
 * everything the renderer produced.
 *
 * Note: Wrapping ranges in <mark> tags would corrupt React's virtual DOM reconciliation; an absolute overlay layer avoids modifying React-managed nodes.
 *
 * The layer also contributes no text, so `root.textContent` — the `answer-v1`
 * projection every anchor is measured against — is byte-identical with and
 * without it.
 */
function ensureFallbackLayer(root: HTMLElement): HTMLElement {
  const existing = root.querySelector<HTMLElement>(`:scope > [${MARK_ATTRIBUTE}]`);
  if (existing) return existing;
  const layer = document.createElement("div");
  layer.setAttribute(MARK_ATTRIBUTE, "");
  layer.setAttribute("aria-hidden", "true");
  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.pointerEvents = "none";
  root.appendChild(layer);
  return layer;
}

/**
 * Paints each resolved range as a box behind the text, for browsers without the
 * registry. One box per client rect, so a passage wrapping across lines is
 * painted line by line rather than as one blanket rectangle.
 */
export function paintFallbackMarks(root: HTMLElement, ranges: readonly Range[]): void {
  fallbackPainting = true;
  try {
    const layer = ensureFallbackLayer(root);
    layer.replaceChildren();
    const origin = root.getBoundingClientRect();
    for (const range of ranges) {
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const box = document.createElement("span");
        box.style.position = "absolute";
        box.style.left = `${rect.left - origin.left}px`;
        box.style.top = `${rect.top - origin.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        // A token reference, not a literal: the wash follows the appearance
        // exactly as the registry layers do (08 §2).
        box.style.background = "var(--research-highlight-bg)";
        layer.appendChild(box);
      }
    }
  } finally {
    fallbackPainting = false;
  }
}

export function clearFallbackMarks(root: HTMLElement): void {
  fallbackPainting = true;
  try {
    root.querySelector<HTMLElement>(`:scope > [${MARK_ATTRIBUTE}]`)?.remove();
  } finally {
    fallbackPainting = false;
  }
}
