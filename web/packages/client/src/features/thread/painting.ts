// Painting annotations into answers (`09-research-document-view.md` §5).
//
// The CSS Custom Highlight API paints ranges without DOM of its own, which is
// the only way to tint text a Markdown renderer produced without rewriting its
// tree, and to tint a passage that crosses element boundaries. The layers, in
// stacking order (the names are the `::highlight()` names in `prose.css`):
//
//   session-research-highlights          saved highlights
//   session-research-branch-passages     passages branches were asked about
//   session-research-highlight-overlaps  where annotations stack     (1)
//   session-research-highlight-hover     the highlight under the pointer (2)
//   session-research-branch-hover        the passage under the pointer   (2)
//   session-research-open-branch         an open branch's passage, underlined (3)
//   session-research-pending-branch      the unsent branch's passage, dashed  (3)
//   session-research-flash               a passage just jumped to       (4)
//   session-research-selected-highlights highlights a selection covers (5)
//
// A layer's `Highlight` object is created once per page and mutated: WebKit
// fails to clear a removed range until the object itself changes.
//
// Firefox before 140 has no registry. There, saved highlights (only those:
// the other layers repaint too often to pay for it) fall back to a painted
// layer behind the text (`paintFallbackMarks`).

export const RESEARCH_HIGHLIGHT_LAYER = "session-research-highlights";
export const RESEARCH_BRANCH_LAYER = "session-research-branch-passages";
export const RESEARCH_OVERLAP_LAYER = "session-research-highlight-overlaps";
export const RESEARCH_HOVER_HIGHLIGHT_LAYER = "session-research-highlight-hover";
export const RESEARCH_HOVER_BRANCH_LAYER = "session-research-branch-hover";
export const RESEARCH_OPEN_BRANCH_LAYER = "session-research-open-branch";
export const RESEARCH_PENDING_BRANCH_LAYER = "session-research-pending-branch";
export const RESEARCH_FLASH_LAYER = "session-research-flash";
export const RESEARCH_SELECTED_LAYER = "session-research-selected-highlights";

export type ResearchHighlightLayer =
  | typeof RESEARCH_HIGHLIGHT_LAYER
  | typeof RESEARCH_BRANCH_LAYER
  | typeof RESEARCH_OVERLAP_LAYER
  | typeof RESEARCH_HOVER_HIGHLIGHT_LAYER
  | typeof RESEARCH_HOVER_BRANCH_LAYER
  | typeof RESEARCH_OPEN_BRANCH_LAYER
  | typeof RESEARCH_PENDING_BRANCH_LAYER
  | typeof RESEARCH_FLASH_LAYER
  | typeof RESEARCH_SELECTED_LAYER;

const PRIORITY: Partial<Record<ResearchHighlightLayer, number>> = {
  [RESEARCH_OVERLAP_LAYER]: 1,
  [RESEARCH_HOVER_HIGHLIGHT_LAYER]: 2,
  [RESEARCH_HOVER_BRANCH_LAYER]: 2,
  [RESEARCH_OPEN_BRANCH_LAYER]: 3,
  [RESEARCH_PENDING_BRANCH_LAYER]: 3,
  [RESEARCH_FLASH_LAYER]: 4,
  [RESEARCH_SELECTED_LAYER]: 5,
};

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

/** Whether passages are tinted by the browser rather than by the fallback. */
export function supportsHighlightApi(): boolean {
  return researchHighlightApi() !== null;
}

/** The layers of one mounted thread page. `dispose` removes them from the
 * page-global registry, so leaving the thread leaves no paint behind. */
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

/** The fallback's layer: one absolutely positioned element after everything
 * the renderer produced. Wrapping ranges in elements would break React's
 * reconciliation of the Markdown tree; the layer contributes no text, so the
 * `answer-v1` projection is the same with and without it. */
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

/** Paints each range as boxes behind the text, one per client rect, for
 * browsers without the registry. */
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
        // A token reference: the wash follows the appearance as the registry
        // layers do (08 §2).
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
