// The floating selection actions (`09-research-document-view.md` §5 item 6).
//
// Highlight (H), Expand/Merge (E) and Ask (A). The bar is placed by
// `researchSelectionActionPlacement` on the selection's last client rect —
// beside it when the width fits, below it otherwise — and the page repositions
// it on scroll and resize rather than dismissing, because the selection stays
// valid while the page moves under it.
//
// The bare keys are claimed here rather than in the app's chord table (07 §5):
// they are only shortcuts while a selection is live, and `resolveAppShortcut`
// has no way to know that.

import {
  isResearchAskActionShortcut,
  isResearchExpandActionShortcut,
  isResearchHighlightActionShortcut,
} from "@session/shared";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { useOverlay } from "../../ui/useOverlay.js";

import { isEditableEventTarget } from "./selection/dom.js";

/** Above the find bar (200) would be wrong — a search opened over a selection
 * should take Escape first — so the popover sits below it. */
export const SELECTION_POPOVER_OVERLAY_PRIORITY = 150;

const ACTION =
  "border-border-default bg-highlight-action text-fg-interactive hover:bg-highlight-action-hover " +
  "focus-visible:ring-focus-ring inline-flex min-h-[27px] w-max items-center gap-[7px] " +
  "rounded-[5px] border px-2 text-sm leading-none shadow-sm outline-none focus-visible:ring-2 " +
  "disabled:text-fg-activity disabled:cursor-default";

const KEYCAP =
  "border-border-subtle text-fg-faint rounded-[3px] border px-1 py-px font-mono text-[10px]";

export interface SelectionPopoverProps {
  left: number;
  top: number;
  /** The selection has scrolled out of the viewport: keep the action alive but
   * stop drawing a bar over unrelated content. */
  offscreen: boolean;
  /** How many stored highlights the selection covers; non-zero turns the first
   * action into Remove. */
  removeCount: number;
  canExpand: boolean;
  canAsk: boolean;
  saving: boolean;
  onHighlight: () => void;
  onExpand: () => void;
  onAsk: () => void;
  onDismiss: () => void;
}

export function SelectionPopover({
  left,
  top,
  offscreen,
  removeCount,
  canExpand,
  canAsk,
  saving,
  onHighlight,
  onExpand,
  onAsk,
  onDismiss,
}: SelectionPopoverProps) {
  useOverlay(true, SELECTION_POPOVER_OVERLAY_PRIORITY, onDismiss);

  useEffect(() => {
    const dismissOnOutsideMouseDown = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-research-selection-actions]")
      ) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (saving || isEditableEventTarget(event.target)) return;
      const action = isResearchAskActionShortcut(event)
        ? canAsk
          ? onAsk
          : null
        : isResearchExpandActionShortcut(event)
          ? canExpand
            ? onExpand
            : null
          : isResearchHighlightActionShortcut(event)
            ? onHighlight
            : null;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      action();
    };
    document.addEventListener("mousedown", dismissOnOutsideMouseDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", dismissOnOutsideMouseDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [canAsk, canExpand, onAsk, onDismiss, onExpand, onHighlight, saving]);

  return createPortal(
    <div
      data-research-selection-actions
      className="fixed z-(--z-context-menu) flex gap-px"
      style={{ left, top, visibility: offscreen ? "hidden" : undefined }}
    >
      <button
        type="button"
        className={ACTION}
        disabled={saving}
        aria-keyshortcuts="H"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onHighlight}
      >
        <span>
          {saving
            ? "Saving…"
            : removeCount > 1
              ? "Remove highlights"
              : removeCount === 1
                ? "Remove highlight"
                : "Highlight"}
        </span>
        <kbd className={KEYCAP} aria-hidden="true">
          H
        </kbd>
      </button>
      {canExpand ? (
        <button
          type="button"
          className={ACTION}
          disabled={saving}
          aria-keyshortcuts="E"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onExpand}
        >
          <span>{removeCount > 1 ? "Merge highlights" : "Expand highlight"}</span>
          <kbd className={KEYCAP} aria-hidden="true">
            E
          </kbd>
        </button>
      ) : null}
      {canAsk ? (
        <button
          type="button"
          className={ACTION}
          disabled={saving}
          aria-keyshortcuts="A"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onAsk}
        >
          <span>Ask</span>
          <kbd className={KEYCAP} aria-hidden="true">
            A
          </kbd>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
