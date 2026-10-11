import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Highlighter } from "lucide-react";
import type { ResearchSelectionAction } from "../../hooks/useResearchTextSelection";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import {
  isResearchAskActionShortcut,
  isResearchExpandActionShortcut,
  isResearchHighlightActionShortcut,
} from "../../lib/researchHighlights";
import { researchSelectionActionPlacement } from "../../lib/researchSelection";
import { ResearchBranchIcon } from "./ResearchIcons";

// The selection actions' size before they have rendered once (three inline
// items, plus the note line when one shows).
const SELECTION_ACTIONS_SIZE = { width: 290, height: 40 };

/** Where the action bar sits for a selection: centred 8px above it. */
function highlightActionPlacement(range: Range, size = SELECTION_ACTIONS_SIZE) {
  return researchSelectionActionPlacement({
    boundingRect: range.getBoundingClientRect(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    width: size.width,
    height: size.height,
  });
}

/** Whether a press is a secondary click (the right button, or Control-click
 * on macOS) on the selected text: inside one of the selection's line boxes. */
function secondaryPressOnSelection(event: MouseEvent) {
  if (event.button !== 2 && !(IS_MAC && event.button === 0 && event.ctrlKey)) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  return [...selection.getRangeAt(0).getClientRects()].some(
    (rect) =>
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom,
  );
}

type Placement = ReturnType<typeof highlightActionPlacement>;

/** The Branch / Highlight / Copy bar over a text selection in an answer.
 * It owns its placement: it is measured and centred over the selection when
 * the selection changes, and follows it across scrolls and resizes, so only
 * the bar re-renders while the selection moves. A press outside the bar, Esc,
 * or the selection going away dismisses it; A branches, H (or E) highlights. */
export function ResearchSelectionToolbar({
  action,
  saving,
  branchBlocker,
  onBranch,
  onHighlight,
  onCopy,
  onDismiss,
}: {
  action: ResearchSelectionAction;
  saving: boolean;
  /** Why the selection cannot start a branch, or null when it can. */
  branchBlocker: string | null;
  onBranch: () => void;
  onHighlight: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  // The bar's measured size, for centring it.
  const sizeRef = useRef(SELECTION_ACTIONS_SIZE);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const handlersRef = useRef({ saving, onBranch, onHighlight, onDismiss });
  handlersRef.current = { saving, onBranch, onHighlight, onDismiss };

  // Centring needs the bar's own size, which depends on its note line: after
  // it renders for a new selection, measure it and place it over the
  // selection.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const selection = window.getSelection();
    if (!bar || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }
    sizeRef.current = { width: bar.offsetWidth, height: bar.offsetHeight };
    const next = highlightActionPlacement(selection.getRangeAt(0), sizeRef.current);
    setPlacement((current) =>
      current?.left === next.left && current.top === next.top && current.offscreen === next.offscreen
        ? current
        : next,
    );
  }, [action, action.live, branchBlocker]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      // A right-click on the selected text opens the webview's menu (Copy)
      // and keeps the selection, so the bar stays with it.
      if (secondaryPressOnSelection(event)) {
        return;
      }
      if (!(event.target instanceof Element) || !event.target.closest(".research-selection-actions")) {
        handlersRef.current.onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handlersRef.current.onDismiss();
        return;
      }
      if (handlersRef.current.saving || isEditableTarget(event.target)) {
        return;
      }
      // H highlights (merging with what it overlaps), E is kept as the old
      // expand/merge key, and A — formerly Ask — starts a branch.
      if (isResearchAskActionShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        handlersRef.current.onBranch();
        return;
      }
      if (isResearchHighlightActionShortcut(event) || isResearchExpandActionShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        handlersRef.current.onHighlight();
      }
    };
    // The selection stays valid across scrolls and resizes, so follow it
    // instead of dismissing (rAF-throttled), and drop the bar only if the
    // selection itself has gone away.
    let repositionFrame: number | null = null;
    const reposition = () => {
      if (repositionFrame !== null) {
        return;
      }
      repositionFrame = window.requestAnimationFrame(() => {
        repositionFrame = null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          handlersRef.current.onDismiss();
          return;
        }
        const next = highlightActionPlacement(selection.getRangeAt(0), sizeRef.current);
        setPlacement((current) =>
          current?.left === next.left && current.top === next.top && current.offscreen === next.offscreen
            ? current
            : next,
        );
      });
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (repositionFrame !== null) {
        window.cancelAnimationFrame(repositionFrame);
      }
    };
  }, []);

  return createPortal(
    <div
      ref={barRef}
      className="popover-surface research-selection-actions"
      role="toolbar"
      aria-label="Selection"
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: !placement || placement.offscreen ? "hidden" : undefined,
      }}
    >
      <div className="research-selection-row">
        <button
          type="button"
          className="control-button research-menu-item is-inline"
          disabled={saving || branchBlocker !== null}
          aria-keyshortcuts="A"
          title={branchBlocker ?? "Branch (A)"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onBranch}
        >
          <ResearchBranchIcon size={14} />
          <span>Branch</span>
        </button>
        <button
          type="button"
          className="control-button research-menu-item is-inline"
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
        <button
          type="button"
          className="control-button research-menu-item is-inline"
          title="Copy"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCopy}
        >
          <Copy size={14} aria-hidden="true" />
          <span>Copy</span>
        </button>
      </div>
      {action.live ? (
        <div className="research-menu-note">
          Highlighting and branching are available when the answer finishes.
        </div>
      ) : branchBlocker === "Wait for the answer to finish" ? (
        <div className="research-menu-note">Branching is available when the answer finishes.</div>
      ) : null}
    </div>,
    document.body,
  );
}
