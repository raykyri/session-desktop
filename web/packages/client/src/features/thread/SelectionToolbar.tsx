// The bar over a text selection in an answer (`09-research-document-view.md`
// §5), ported from the desktop `ResearchSelectionToolbar.tsx`: Branch to
// right, Highlight (or Remove highlight) and Copy. It places itself centred
// above the selection and follows it through scrolls and resizes. A press
// outside it, Esc, or the selection going away dismisses it; A branches, H (or
// E) highlights.

import {
  isResearchAskActionShortcut,
  isResearchExpandActionShortcut,
  isResearchHighlightActionShortcut,
} from "@session/shared/lib/researchHighlights";
import { researchSelectionActionPlacement } from "@session/shared/lib/researchSelection";
import { ArrowUpRight, Copy, Highlighter } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/cn.js";
import { MENU_ITEM, POPOVER_SURFACE } from "../../ui/surfaces.js";

import type { SelectionAction } from "./selectionCapture.js";
import { isEditableEventTarget } from "./textRanges.js";
import { useLatest } from "./useLatest.js";

const INITIAL_SIZE = { width: 300, height: 40 };

function placementFor(range: Range, size: { width: number; height: number }) {
  return researchSelectionActionPlacement({
    boundingRect: range.getBoundingClientRect(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    width: size.width,
    height: size.height,
  });
}

type Placement = ReturnType<typeof placementFor>;

export function SelectionToolbar({
  action,
  saving,
  branchBlocker,
  onBranch,
  onHighlight,
  onCopy,
  onDismiss,
  canAnnotate = true,
}: {
  action: SelectionAction;
  saving: boolean;
  /** Why the selection cannot start a branch, or null. */
  branchBlocker: string | null;
  onBranch: () => void;
  onHighlight: () => void;
  onCopy: () => void;
  onDismiss: () => void;
  /** Branch and Highlight are offered (web only: not to a viewer or a
   * guest, who get Copy alone). */
  canAnnotate?: boolean;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef(INITIAL_SIZE);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const handlersRef = useLatest({ saving, canAnnotate, onBranch, onHighlight, onDismiss });

  useLayoutEffect(() => {
    const bar = barRef.current;
    const selection = window.getSelection();
    if (!bar || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    sizeRef.current = {
      width: bar.offsetWidth || INITIAL_SIZE.width,
      height: bar.offsetHeight || INITIAL_SIZE.height,
    };
    const next = placementFor(selection.getRangeAt(0), sizeRef.current);
    setPlacement((current) =>
      current?.left === next.left &&
      current.top === next.top &&
      current.offscreen === next.offscreen
        ? current
        : next,
    );
  }, [action, branchBlocker]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-research-selection-actions]")
      ) {
        handlersRef.current.onDismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handlersRef.current.onDismiss();
        return;
      }
      if (handlersRef.current.saving || isEditableEventTarget(event.target)) return;
      if (!handlersRef.current.canAnnotate) return;
      if (isResearchAskActionShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handlersRef.current.onBranch();
        return;
      }
      if (isResearchHighlightActionShortcut(event) || isResearchExpandActionShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handlersRef.current.onHighlight();
      }
    };
    let frame: number | null = null;
    const reposition = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          handlersRef.current.onDismiss();
          return;
        }
        const next = placementFor(selection.getRangeAt(0), sizeRef.current);
        setPlacement((current) =>
          current?.left === next.left &&
          current.top === next.top &&
          current.offscreen === next.offscreen
            ? current
            : next,
        );
      });
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [handlersRef]);

  const item = cn(MENU_ITEM, "w-auto px-2 py-1 text-sm");
  return createPortal(
    <div
      ref={barRef}
      className={cn(POPOVER_SURFACE, "fixed z-(--z-popover) rounded-lg p-1")}
      role="toolbar"
      aria-label="Selection"
      data-research-selection-actions=""
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: !placement || placement.offscreen ? "hidden" : undefined,
      }}
    >
      <div className="flex items-center gap-0.5">
        {canAnnotate ? (
          <>
            <button
              type="button"
              className={item}
              disabled={saving || branchBlocker !== null}
              aria-keyshortcuts="A"
              title={branchBlocker ?? "Branch to right (A)"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onBranch}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              <span>Branch to right</span>
            </button>
            <button
              type="button"
              className={item}
              disabled={saving || action.live}
              aria-keyshortcuts="H"
              title={action.live ? "Wait for the answer to finish" : "Highlight (H)"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onHighlight}
            >
              <Highlighter size={14} aria-hidden="true" />
              <span>
                {saving
                  ? "Saving…"
                  : action.expandAnchor || action.highlightIds.length === 0
                    ? "Highlight"
                    : action.highlightIds.length > 1
                      ? "Remove highlights"
                      : "Remove highlight"}
              </span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={item}
          title="Copy"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCopy}
        >
          <Copy size={14} aria-hidden="true" />
          <span>Copy</span>
        </button>
      </div>
      {!canAnnotate ? null : action.live ? (
        <div className="text-fg-muted px-2 pt-1 pb-0.5 text-xs">
          Highlighting and branching are available when the answer finishes.
        </div>
      ) : branchBlocker === "Wait for the answer to finish" ? (
        <div className="text-fg-muted px-2 pt-1 pb-0.5 text-xs">
          Branching is available when the answer finishes.
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
