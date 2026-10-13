import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { researchTileOverflows } from "../../lib/researchTileClamp";

// One observer for every clamped row: a thread shows many rows, and one
// observer reads all their sizes in a single pass after layout.
let sharedObserver: ResizeObserver | null = null;
const measureByElement = new WeakMap<Element, () => void>();

function observeSize(element: Element, measure: () => void): () => void {
  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      measureByElement.get(entry.target)?.();
    }
  });
  measureByElement.set(element, measure);
  sharedObserver.observe(element);
  return () => {
    sharedObserver?.unobserve(element);
    measureByElement.delete(element);
  };
}

/** The clamp box of a message row's text: `ref` and `id` go on the element
 * with the .research-msg-clamp class, and `overflows` says whether the text
 * is longer than the clamp, so the row shows Show more. The box is measured
 * while clamped, again when its size changes (the column's width, the text),
 * and when the row collapses. Expanded text is not measured: the row keeps
 * Show less until it collapses. */
export function useResearchTileClamp(expanded: boolean) {
  const id = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflows, setOverflows] = useState(expanded);
  const expandedRef = useRef(expanded);

  useLayoutEffect(() => {
    expandedRef.current = expanded;
    if (element && !expanded) {
      setOverflows(researchTileOverflows(element.scrollHeight, element.clientHeight));
    }
  }, [element, expanded]);

  useEffect(() => {
    if (!element) {
      return;
    }
    return observeSize(element, () => {
      if (!expandedRef.current) {
        setOverflows(researchTileOverflows(element.scrollHeight, element.clientHeight));
      }
    });
  }, [element]);

  return {
    id,
    ref: setElement,
    className: `research-msg-clamp${expanded ? "" : " is-clamped"}`,
    overflows,
  };
}

/** Show more or Show less below a clamped row's text. It is its own target
 * above the row's selection button, and a press on it starts no drag. */
export function ResearchTileToggle({
  controls,
  expanded,
  tabIndex,
  onToggle,
}: {
  /** The id of the clamp box. */
  controls: string;
  expanded: boolean;
  tabIndex: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="research-msg-more"
      data-research-no-drag=""
      aria-expanded={expanded}
      aria-controls={controls}
      tabIndex={tabIndex}
      onClick={onToggle}
      // A double-click on the row edits it; on the toggle it only toggles.
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {expanded ? "Show less" : "Show more"}
    </button>
  );
}
