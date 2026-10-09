import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import { ChevronLeft, ChevronRight, CornerDownRight, Star, X } from "lucide-react";

const OPEN_MS = 220;
const OPEN_EASING = "cubic-bezier(0.2, 0, 0, 1)";
const CLOSE_MS = 160;
const CLOSE_EASING = "cubic-bezier(0.4, 0, 1, 1)";
const SWAP_MS = 120;
const PIN_FADE_MS = 120;

/** The system setting or the app's own Reduce motion setting. */
export function prefersReducedMotion() {
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
    document.querySelector(".app-shell.reduce-motion") !== null
  );
}

function canAnimate(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element && typeof element.animate === "function") && !prefersReducedMotion();
}

/** One-row header shared by the branch drawer and pinned branch columns:
 * back to the parent branch, the branch's own title, sibling arrows, star,
 * and the column's trailing actions. */
export function ResearchBranchHeader({
  title,
  titleRef,
  backLabel,
  onBack,
  siblings,
  promoted,
  canPromote,
  onTogglePromoted,
  onPin,
  onClose,
  closeLabel,
  onFocusColumn,
}: {
  title: string;
  titleRef?: Ref<HTMLHeadingElement>;
  backLabel?: string;
  onBack?: () => void;
  siblings?: { index: number; count: number; onStep: (delta: -1 | 1) => void } | null;
  promoted: boolean;
  canPromote: boolean;
  onTogglePromoted?: () => void;
  onPin?: () => void;
  onClose?: () => void;
  closeLabel: string;
  onFocusColumn?: () => void;
}) {
  return (
    <header className="research-column-header is-branch" onMouseDown={onFocusColumn}>
      <div className="research-column-bar" data-tauri-drag-region>
        {onBack ? (
          <button
            type="button"
            className="control-button research-icon-button"
            title={backLabel}
            aria-label={backLabel ?? "Back"}
            onClick={onBack}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        ) : null}
        <h2 ref={titleRef} className="research-column-title is-one-line" tabIndex={-1} title={title}>
          {title}
        </h2>
        <span className="research-column-spacer" data-tauri-drag-region />
        {siblings && siblings.count > 1 ? (
          <span className="research-branch-siblings">
            <button
              type="button"
              className="control-button research-icon-button"
              disabled={siblings.index === 0}
              aria-label="Previous sibling branch"
              onClick={() => siblings.onStep(-1)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span className="research-tnum">
              {siblings.index + 1}/{siblings.count}
            </span>
            <button
              type="button"
              className="control-button research-icon-button"
              disabled={siblings.index === siblings.count - 1}
              aria-label="Next sibling branch"
              onClick={() => siblings.onStep(1)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </span>
        ) : null}
        {canPromote && onTogglePromoted ? (
          <button
            type="button"
            className={`control-button research-icon-button research-branch-star${
              promoted ? " is-on" : ""
            }`}
            aria-pressed={promoted}
            aria-label="Star branch"
            title={
              promoted
                ? "Unstar: stop listing this branch under its question"
                : "Star: list this branch under its question in the feed"
            }
            onClick={onTogglePromoted}
          >
            <Star size={15} aria-hidden="true" fill={promoted ? "currentColor" : "none"} />
          </button>
        ) : null}
        {onPin ? (
          <button
            type="button"
            className="control-button research-tint-button research-branch-pin"
            title="Keep this branch open as a column"
            onClick={onPin}
          >
            Pin as column
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className="control-button research-icon-button"
            title={closeLabel}
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** The passage a branch was asked about, one muted line at the top of its
 * body. It scrolls the parent to the passage. In a branch with no turns yet
 * it wraps, since it is the context for the first question. */
export function ResearchBranchSource({
  quote,
  previousQuote,
  parentTitle,
  full,
  onJump,
}: {
  quote: string | null;
  /** The quote of an anchor that no longer resolves (its answer was rerun). */
  previousQuote?: string | null;
  parentTitle: string;
  full: boolean;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      className={`research-branch-source${full ? " is-full" : ""}`}
      title={`Show the passage in ${parentTitle}`}
      onClick={onJump}
    >
      <CornerDownRight size={13} aria-hidden="true" />
      <span className="research-branch-source-quote">
        {quote ? (
          <>
            <span className="research-visually-hidden">From </span>“{quote}”
          </>
        ) : (
          `From the whole answer${previousQuote ? ` (was “${previousQuote}”, before the answer was rerun)` : ""}`
        )}
      </span>
      <span className="research-visually-hidden"> in {parentTitle}</span>
    </button>
  );
}

/** The branch drawer: an overlay on the right of the column area that never
 * changes the layout of the columns under it. Opening slides it in from the
 * right edge; replacing its content fades header and body in from 25%
 * without a slide; closing slides it out (or, when it is pinned, fades it)
 * and unmounts it when the animation ends. Only transform and opacity
 * animate, and the Web Animations API runs on a stable element, so renders
 * during a transition continue it and later renders add no animation. */
export function ResearchBranchDrawer({
  ref: outerRef,
  width,
  full,
  label,
  contentKey,
  animateOpen,
  leaving,
  onLeft,
  children,
}: {
  ref?: RefObject<HTMLElement | null>;
  width: number;
  /** Single-column mode: the drawer covers the whole column area. */
  full: boolean;
  label: string;
  /** Changes when the drawer shows a different branch. */
  contentKey: string;
  /** False when the drawer is restored on mount rather than opened. */
  animateOpen: boolean;
  /** Set while this drawer is on its way out. */
  leaving: "close" | "pin" | null;
  onLeft: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const setElement = useCallback(
    (element: HTMLElement | null) => {
      ref.current = element;
      if (outerRef) {
        outerRef.current = element;
      }
    },
    [outerRef],
  );
  const openedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const firstContentRef = useRef(true);
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!animateOpen || !canAnimate(element)) {
      return;
    }
    openedAtRef.current = performance.now();
    const shadow = getComputedStyle(element).boxShadow;
    element.animate(
      [
        { transform: "translateX(100%)", boxShadow: "none" },
        { transform: "translateX(0)", boxShadow: shadow },
      ],
      { duration: OPEN_MS, easing: OPEN_EASING },
    );
    // Mount-only: the slide-in belongs to this drawer instance.
  }, []);

  useLayoutEffect(() => {
    if (firstContentRef.current) {
      firstContentRef.current = false;
      return;
    }
    const element = ref.current;
    // A swap during the slide-in leaves the slide-in running.
    if (leaving || !canAnimate(element) || performance.now() - openedAtRef.current < OPEN_MS) {
      return;
    }
    for (const child of Array.from(element.children)) {
      (child as HTMLElement).animate([{ opacity: 0.25 }, { opacity: 1 }], {
        duration: SWAP_MS,
        easing: "ease-out",
      });
    }
    // Only a content change animates; `leaving` is read, not tracked.
  }, [contentKey]);

  useEffect(() => {
    if (!leaving) {
      return;
    }
    const element = ref.current;
    if (!canAnimate(element)) {
      onLeftRef.current();
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        onLeftRef.current();
      }
    };
    const animation =
      leaving === "close"
        ? element.animate(
            [
              { transform: "translateX(0)" },
              { transform: "translateX(100%)", boxShadow: "none" },
            ],
            { duration: CLOSE_MS, easing: CLOSE_EASING, fill: "forwards" },
          )
        : element.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: PIN_FADE_MS,
            easing: "linear",
            fill: "forwards",
          });
    animation.onfinish = finish;
    // A fallback in case the animation never finishes (a hidden window).
    const timer = window.setTimeout(finish, 400);
    return () => {
      window.clearTimeout(timer);
      done = true;
    };
  }, [leaving]);

  return (
    <aside
      ref={setElement}
      className={`research-branch-drawer${full ? " is-full" : ""}${leaving ? " is-leaving" : ""}`}
      style={full ? undefined : { width }}
      aria-label={label}
      inert={leaving ? true : undefined}
    >
      {children}
    </aside>
  );
}
