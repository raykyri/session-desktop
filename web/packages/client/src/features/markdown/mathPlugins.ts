// The lazily-loaded TeX half of the Markdown pipeline (`08-design-system-and-
// styling.md` §5).
//
// `loadMathPlugins` (shared) imports remark-math and rehype-mathjax behind a
// dynamic `import()`, so MathJax's glyph tables stay out of the main chunk.
// rehype plugins run synchronously inside `ReactMarkdown`, so the chunk cannot
// be awaited at render time: a mounted renderer subscribes here through
// `useSyncExternalStore` and re-renders with the combined plugin lists once the
// chunk lands. Until then — and forever, if the chunk fails to load — TeX
// renders as its literal source, which is readable rather than blank.
//
// The load is requested by the first renderer whose source actually looks like
// it contains TeX, rather than at module scope: most answers have no math in
// them, and MathJax is the largest chunk in the app.

import { loadMathPlugins } from "@session/shared";
import type { PluggableList } from "unified";

export interface MathPlugins {
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
}

let plugins: MathPlugins | null = null;
const listeners = new Set<() => void>();

/** Requests the math chunk, or resolves at once if it is already in. Called by
 * a renderer whose source contains TeX. If KaTeX rendering fails, display the
 * raw TeX source instead. */
export function ensureMathPlugins(): Promise<void> {
  if (plugins) return Promise.resolve();
  return loadMathPlugins()
    .then((loaded) => {
      plugins = loaded;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // A chunk that failed once is not memoized by `loadMathPlugins`, so the
      // next renderer that needs math asks for it again.
    });
}

export function subscribeToMathPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a source is worth fetching MathJax for. Deliberately loose — a
 * false positive costs one chunk, a false negative leaves TeX as literal
 * source forever. */
const MATH_HINT = /\$|\\\(|\\\[/;

export function sourceMayContainMath(source: string): boolean {
  return MATH_HINT.test(source);
}

export function readMathPlugins(): MathPlugins | null {
  return plugins;
}

/** Test seam: drops the loaded plugins so a case can assert the pre-load
 * rendering (TeX as source). */
export function resetMathPluginsForTests(): void {
  plugins = null;
  listeners.clear();
}
