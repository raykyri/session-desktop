// DOM-range search over React-rendered pane content. Matches are painted with
// the CSS Custom Highlight API instead of marker elements, which would fight
// React's reconciliation.

interface TranscriptSearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

// Highlight registry names, referenced by ::highlight() rules in find-bar.css.
const TRANSCRIPT_SEARCH_HIGHLIGHT = "transcript-search-match";
const TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT = "transcript-search-active-match";

// Upper bound on collected matches. A one-character term over a long transcript can
// match tens of thousands of times; keeping every one as a live DOM Range (and
// painting it) burns memory and main-thread time for no navigational benefit. Beyond
// this cap, collection stops — the label shows the cap and the user refines the term.
const MAX_SEARCH_MATCHES = 2000;

// The Custom Highlight API may be missing from older TS DOM libs/webviews, so it
// is reached through narrow structural types and feature-checked at runtime.
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

// A Highlight is a Set-like of ranges; add() lets us fill it without spreading the
// range list as constructor arguments.
interface HighlightLike {
  add(range: Range): void;
}

function highlightRegistry(): HighlightRegistryLike | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) {
    return null;
  }
  return (CSS as unknown as { highlights: HighlightRegistryLike }).highlights;
}

function highlightConstructor(): (new () => HighlightLike) | null {
  const ctor = (globalThis as Record<string, unknown>).Highlight;
  return typeof ctor === "function" ? (ctor as new () => HighlightLike) : null;
}

// Builds a Highlight from ranges via add() in a loop. `new Highlight(...ranges)`
// spreads every range as a call argument, which throws RangeError once the count
// exceeds the engine's max-argument limit (~65k in WebKit) — an uncaught throw inside
// the caller's effect that blanks the app. add() has no such limit.
function buildHighlight(Highlight: new () => HighlightLike, ranges: Range[]): HighlightLike {
  const highlight = new Highlight();
  for (const range of ranges) {
    highlight.add(range);
  }
  return highlight;
}

// Registry keys are global, with one painted slot per name. Track the rendered
// pane that set the highlights so another pane's cleanup cannot clear them.
let highlightOwner: object | null = null;

// Paints all matches plus the active match and records `owner`. On webviews
// without the Highlight API, search still navigates by scrolling.
export function applySearchHighlights(owner: object, ranges: Range[], activeIndex: number) {
  const registry = highlightRegistry();
  const Highlight = highlightConstructor();
  if (!registry || !Highlight) {
    return;
  }
  highlightOwner = owner;
  if (ranges.length === 0) {
    registry.delete(TRANSCRIPT_SEARCH_HIGHLIGHT);
    registry.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
    return;
  }
  registry.set(TRANSCRIPT_SEARCH_HIGHLIGHT, buildHighlight(Highlight, ranges));
  const active = ranges[activeIndex];
  if (active) {
    registry.set(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT, buildHighlight(Highlight, [active]));
  } else {
    registry.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
  }
}

// Clears highlights only when `owner` last painted them, preventing a background
// overlay's cleanup from clearing the active overlay's highlights.
export function clearSearchHighlights(owner: object) {
  if (highlightOwner !== null && highlightOwner !== owner) {
    return;
  }
  highlightOwner = null;
  const registry = highlightRegistry();
  registry?.delete(TRANSCRIPT_SEARCH_HIGHLIGHT);
  registry?.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
}

function buildSearchPattern(term: string, options: TranscriptSearchOptions): RegExp | null {
  if (!term) {
    return null;
  }
  const source = options.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch {
    // An invalid user regex mid-typing just means "no matches" until it parses.
    return null;
  }
}

// Collects a Range per match, in document order. Matches stay within a single
// text node (like the terminal's per-line search). Matches with no client rects
// are omitted because unrendered content (such as a collapsed <details>) cannot
// be highlighted or scrolled to.
export function collectSearchRanges(
  root: HTMLElement,
  term: string,
  options: TranscriptSearchOptions,
): Range[] {
  const pattern = buildSearchPattern(term, options);
  if (!pattern) {
    return [];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  collect: for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) {
      continue;
    }
    const textRange = document.createRange();
    textRange.selectNodeContents(node);
    if (textRange.getClientRects().length === 0) continue;
    for (const match of text.matchAll(pattern)) {
      if (match[0].length === 0) {
        // A zero-width regex match (e.g. `a*`) has nothing to highlight.
        continue;
      }
      const start = match.index ?? 0;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + match[0].length);
      if (range.getClientRects().length === 0) continue;
      ranges.push(range);
      // Stop once capped: a broad term can match far more than is useful, and every
      // extra Range costs memory and (below) a forced layout read.
      if (ranges.length >= MAX_SEARCH_MATCHES) {
        break collect;
      }
    }
  }
  return ranges;
}

/** Combines matches in root order and returns the selected match's index.
 * Preserves the previous match when present, even if its index changed;
 * otherwise selects the match chosen by `nearest`. */
export function mergeSearchMatches<T>(
  perRoot: readonly (readonly T[])[],
  previous: T | undefined,
  same: (left: T, right: T) => boolean,
  nearest: (matches: T[]) => number,
): { matches: T[]; index: number } {
  const matches = perRoot.flat() as T[];
  const kept = previous === undefined ? -1 : matches.findIndex((match) => same(match, previous));
  return { matches, index: kept >= 0 ? kept : nearest(matches) };
}

// Select the first match visible in or below the viewport when the search opens
// or the query changes. Use the last match when all matches are above it.
export function nearestSearchRangeIndex(viewport: HTMLElement, ranges: Range[]): number {
  if (ranges.length === 0) {
    return -1;
  }
  const viewportTop = viewport.getBoundingClientRect().top;
  const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= viewportTop);
  return index === -1 ? ranges.length - 1 : index;
}

// Centers the viewport on the range unless it is already comfortably in view.
export function scrollSearchRangeIntoView(viewport: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  const margin = 40;
  if (rect.top >= view.top + margin && rect.bottom <= view.bottom - margin) {
    return;
  }
  viewport.scrollTop += rect.top - view.top - view.height / 2;
}
