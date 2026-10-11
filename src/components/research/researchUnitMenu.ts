import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  researchMenuPoint,
  type ResearchMenuAlign,
  type ResearchMenuRect,
} from "./ResearchMenu";

// Context menus on units that have a … menu (a message row, an answer, a
// post, a feed row): a right-click opens the unit's menu at the pointer, and
// Shift+F10 or the ContextMenu key opens it at the unit's … button.

/** Where a unit's menu opens: the anchor rectangle and the alignment passed
 * to ResearchMenu. */
export interface ResearchUnitMenuPlacement {
  anchor: ResearchMenuRect;
  align: ResearchMenuAlign;
}

/** Targets whose own right-click behaviour is kept: links (Session's link
 * menu, or the webview's), media (the webview's image and video menu), and
 * form fields (the webview's edit menu). */
const NATIVE_MENU_TARGET_SELECTOR =
  "a[href], img, video, audio, input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** Whether a key press asks for the focused unit's context menu: the
 * ContextMenu key, or Shift+F10, without ⌘, Ctrl or ⌥ and outside IME
 * composition. */
export function isResearchUnitMenuKey(event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/** Whether a context-menu request on a unit opens the unit's menu. It does
 * not when a handler inside the unit already took the event (a link's or a
 * diagram's own menu), when the target keeps its own menu (a link, an image,
 * a form field), or when the unit holds a non-empty text selection: the
 * selection, its Highlight/Branch bar and the webview's Copy menu stay. */
export function researchUnitMenuOpens({
  handled,
  nativeTarget,
  selectionText,
  selectionInUnit,
}: {
  handled: boolean;
  nativeTarget: boolean;
  selectionText: string;
  selectionInUnit: boolean;
}): boolean {
  if (handled || nativeTarget) return false;
  return !(selectionInUnit && selectionText.trim() !== "");
}

/** Where a menu opened from the keyboard goes: against the unit's … button,
 * aligned as a click on it opens, when the button is on screen; otherwise at
 * the top-left corner of the unit's part inside the viewport. */
export function researchUnitKeyboardPlacement(
  button: { rect: ResearchMenuRect; align: ResearchMenuAlign } | null,
  unit: ResearchMenuRect,
  viewport: { width: number; height: number },
): ResearchUnitMenuPlacement {
  if (button) return { anchor: button.rect, align: button.align };
  const x = Math.min(Math.max(unit.left, 0), viewport.width);
  const y = Math.min(Math.max(unit.top, 0), viewport.height);
  return { anchor: researchMenuPoint(x, y), align: "point" };
}

function selectionInside(unit: Element): { text: string; inside: boolean } {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return { text: "", inside: false };
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(unit)) {
      return { text: selection.toString(), inside: true };
    }
  }
  return { text: "", inside: false };
}

/** A visible … button: laid out, and the topmost element at its centre (not
 * scrolled out of its column or covered). */
function visibleButtonRect(button: HTMLElement | null): DOMRect | null {
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit && button.contains(hit) ? rect : null;
}

function opensFor(unit: HTMLElement, target: EventTarget | null, handled: boolean): boolean {
  if (!(target instanceof Node) || !unit.contains(target)) {
    // An event from a portal (an open menu) bubbles through React parents
    // it is not inside.
    return false;
  }
  const element = target instanceof Element ? target : target.parentElement;
  const selection = selectionInside(unit);
  return researchUnitMenuOpens({
    handled,
    nativeTarget: Boolean(element?.closest(NATIVE_MENU_TARGET_SELECTOR)),
    selectionText: selection.text,
    selectionInUnit: selection.inside,
  });
}

/** The props that give a unit its context menu: `onContextMenu` for a
 * right-click and `onKeyDown` for Shift+F10 and the ContextMenu key. `open`
 * opens the same menu as the unit's … button, at the given placement (`unit`
 * is the element carrying these props); the menu takes focus and returns it
 * to what had it (the focused row, for a keyboard open) when it closes.
 * `menuButton` names the unit's … button and its menu's alignment, for
 * keyboard placement. */
export function researchUnitMenuProps(
  open: (placement: ResearchUnitMenuPlacement, unit: HTMLElement) => void,
  menuButton?: (unit: HTMLElement) => { element: HTMLElement | null; align: ResearchMenuAlign } | null,
) {
  return {
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      if (!opensFor(event.currentTarget, event.target, event.defaultPrevented)) return;
      event.preventDefault();
      event.stopPropagation();
      open({ anchor: researchMenuPoint(event.clientX, event.clientY), align: "point" }, event.currentTarget);
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (!isResearchUnitMenuKey(event)) return;
      const unit = event.currentTarget;
      if (!opensFor(unit, event.target, event.defaultPrevented)) return;
      // A contextmenu event the browser may still dispatch for the key goes
      // to the focused element, by then an item of the open menu, whose
      // popover cancels it.
      event.preventDefault();
      event.stopPropagation();
      const button = menuButton?.(unit) ?? null;
      const rect = visibleButtonRect(button?.element ?? null);
      open(
        researchUnitKeyboardPlacement(
          rect && button ? { rect, align: button.align } : null,
          unit.getBoundingClientRect(),
          { width: window.innerWidth, height: window.innerHeight },
        ),
        unit,
      );
    },
  };
}
