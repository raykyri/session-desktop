import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MessageSquarePlus } from "lucide-react";

/** One edge-to-edge frame of the morphing surface, in px from the pane's
 * left, right and bottom edges. */
interface MorphBox {
  left: number;
  right: number;
  bottom: number;
  height: number;
  radius: number;
}

interface Morph {
  direction: "collapse" | "expand";
  from: MorphBox;
  to: MorphBox;
}

// The restore button's size and its inset from the pane's bottom-right corner.
const RESTORE_SIZE = 44;
const RESTORE_INSET_RIGHT = 20;
const RESTORE_INSET_BOTTOM = 16;
// The bar's corner radius (.research-followup-composer.is-thread).
const BAR_RADIUS = 10;
// Longest edge transition per direction in research.css, including delays.
// Collapse ends with the left edge (340ms); expand with the right edge
// (30ms delay + 340ms).
const MORPH_DURATION_MS = { collapse: 340, expand: 370 } as const;

// The app's Reduce motion setting marks the shell; the OS setting is a media
// query. Either one swaps the bar and the button without the morph.
function prefersReducedMotion(element: Element | null) {
  return (
    Boolean(element?.closest(".reduce-motion")) ||
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

function boxFromRect(rect: DOMRect, pane: DOMRect, radius: number): MorphBox {
  return {
    left: rect.left - pane.left,
    right: pane.right - rect.right,
    bottom: pane.bottom - rect.bottom,
    height: rect.height,
    radius,
  };
}

function restoreBox(pane: DOMRect): MorphBox {
  return {
    left: pane.width - RESTORE_INSET_RIGHT - RESTORE_SIZE,
    right: RESTORE_INSET_RIGHT,
    bottom: RESTORE_INSET_BOTTOM,
    height: RESTORE_SIZE,
    radius: RESTORE_SIZE / 2,
  };
}

function boxStyle(box: MorphBox) {
  return {
    left: box.left,
    right: box.right,
    bottom: box.bottom,
    height: box.height,
    borderRadius: box.radius,
  };
}

/**
 * Minimizes the thread follow-up bar into a round button at the pane's
 * bottom-right corner. The bar and the button live in different containers
 * (the bar in the scrolling column, the button in the pane), so a separate
 * surface in the pane animates between their measured boxes, and each is
 * shown only once that surface has reached it.
 */
export function useFollowupBarMinimizer({
  paneRef,
  barRef,
  onRestored,
}: {
  paneRef: RefObject<HTMLElement | null>;
  barRef: RefObject<HTMLElement | null>;
  onRestored: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  const [morph, setMorph] = useState<Morph | null>(null);
  // The morph whose target box has been applied. Tracked by identity so a
  // morph that replaces one in flight still starts from its own first box.
  const [startedMorph, setStartedMorph] = useState<Morph | null>(null);
  const morphRef = useRef<HTMLDivElement | null>(null);
  const restoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  // Set when a restore un-hides the bar; the bar's controls can only take
  // focus once that render has committed.
  const restoredRef = useRef(false);

  useEffect(() => {
    if (!minimized && restoredRef.current) {
      restoredRef.current = false;
      onRestoredRef.current();
    }
  }, [minimized]);

  const minimize = useCallback(() => {
    if (minimized || morph) {
      return;
    }
    const pane = paneRef.current?.getBoundingClientRect();
    const bar = barRef.current?.getBoundingClientRect();
    setMinimized(true);
    if (pane && bar && bar.width > 0 && !prefersReducedMotion(paneRef.current)) {
      setMorph({
        direction: "collapse",
        from: boxFromRect(bar, pane, BAR_RADIUS),
        to: restoreBox(pane),
      });
    }
  }, [barRef, minimized, morph, paneRef]);

  const restore = useCallback(() => {
    if (!minimized || morph?.direction === "expand") {
      return;
    }
    const pane = paneRef.current?.getBoundingClientRect();
    // The hidden bar keeps its layout box, so it can be measured.
    const bar = barRef.current?.getBoundingClientRect();
    if (!pane || !bar || bar.width === 0 || prefersReducedMotion(paneRef.current)) {
      setMorph(null);
      restoredRef.current = true;
      setMinimized(false);
      return;
    }
    const button = restoreButtonRef.current?.getBoundingClientRect();
    setMorph({
      direction: "expand",
      from: button ? boxFromRect(button, pane, RESTORE_SIZE / 2) : restoreBox(pane),
      to: boxFromRect(bar, pane, BAR_RADIUS),
    });
  }, [barRef, minimized, morph, paneRef]);

  // Commit the starting box, force a style pass so the browser records it,
  // then move to the target box; the edge transitions in research.css run
  // between the two.
  useLayoutEffect(() => {
    if (!morph) {
      return;
    }
    void morphRef.current?.getBoundingClientRect();
    setStartedMorph(morph);
  }, [morph]);

  useEffect(() => {
    if (!morph) {
      return;
    }
    const timer = window.setTimeout(() => {
      setMorph(null);
      if (morph.direction === "expand") {
        restoredRef.current = true;
        setMinimized(false);
      }
    }, MORPH_DURATION_MS[morph.direction]);
    return () => window.clearTimeout(timer);
  }, [morph]);

  const renderLayer = (hasDraft: boolean) => (
    <>
      {morph ? (
        <div
          ref={morphRef}
          className={`research-followup-morph is-${morph.direction}`}
          style={boxStyle(startedMorph === morph ? morph.to : morph.from)}
          aria-hidden="true"
        >
          <span className="research-followup-morph-icon">
            <MessageSquarePlus size={18} strokeWidth={1.8} />
          </span>
        </div>
      ) : null}
      {minimized && !morph ? (
        <button
          ref={restoreButtonRef}
          type="button"
          className="research-followup-restore"
          aria-label="Ask a follow-up"
          title="Ask a follow-up (⌘J)"
          onClick={restore}
        >
          <MessageSquarePlus size={18} strokeWidth={1.8} aria-hidden="true" />
          {hasDraft ? (
            <span className="research-followup-restore-draft" aria-hidden="true" />
          ) : null}
        </button>
      ) : null}
    </>
  );

  return { minimized, minimize, restore, renderLayer };
}
