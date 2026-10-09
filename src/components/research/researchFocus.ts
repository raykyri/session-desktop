import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// Focus bookkeeping for the research menus and dialogs: where focus returns
// when one closes, and Tab kept inside a modal dialog.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Each open menu's popover → where focus returns when it closes. */
const menuReturnFocus = new WeakMap<Element, HTMLElement>();

export function registerResearchMenuReturnFocus(popover: Element, returnFocus: HTMLElement) {
  menuReturnFocus.set(popover, returnFocus);
}

/** Captures the return-focus target before opening a dialog: the focused
 * element, or the menu trigger when a research menu item has focus.
 * Returns null when nothing has focus. */
function researchFocusOrigin(): HTMLElement | null {
  // Server rendering (tests) has no document.
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest(".research-menu");
  return menu ? menuReturnFocus.get(menu) ?? null : active;
}

/** Where focus goes after a menu or dialog closed, or null to leave it:
 * nowhere while focus is on a connected element other than the body (the
 * chosen action put it there on purpose) or a modal dialog is open (an
 * action that opened one leaves focus to it); otherwise `target`, or
 * `fallback` when the target was removed too. */
export function researchFocusRestoreTarget<T extends { isConnected: boolean }>({
  active,
  body,
  target,
  fallback,
  modalOpen,
}: {
  active: T | null;
  body: T;
  target: T | null;
  fallback?: () => T | null | undefined;
  modalOpen: boolean;
}): T | null {
  if (active && active !== body && active.isConnected) return null;
  if (modalOpen) return null;
  if (target?.isConnected) return target;
  const next = fallback?.();
  return next?.isConnected ? next : null;
}

/** Restores focus (see researchFocusRestoreTarget) on the next animation
 * frame, after the menu or dialog closes and the chosen action updates the DOM. */
export function restoreResearchFocus(
  target: HTMLElement | null,
  fallback?: () => HTMLElement | null | undefined,
) {
  window.requestAnimationFrame(() => {
    const next = researchFocusRestoreTarget<Element>({
      active: document.activeElement,
      body: document.body,
      target,
      fallback,
      modalOpen: document.querySelector('[aria-modal="true"]') !== null,
    });
    if (next instanceof HTMLElement) next.focus({ preventScroll: true });
  });
}

/** The index Tab moves focus to inside a modal dialog with `count` focusable
 * controls and focus on `index` (-1: none of them), when it has to wrap: from
 * the last control to the first (or, with Shift, the first to the last), or
 * into the dialog from outside it. Null when the browser's own move stays
 * inside. */
export function researchDialogTabTarget(index: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

/** keydown handler for a modal dialog element: keeps Tab and ⇧Tab among the
 * dialog's own controls. */
export function trapResearchDialogTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getClientRects().length > 0,
  );
  const next = researchDialogTabTarget(
    controls.indexOf(document.activeElement as HTMLElement),
    controls.length,
    event.shiftKey,
  );
  if (next === null) return;
  event.preventDefault();
  controls[next]?.focus();
}

/** Returns focus when a dialog closes. While `open` turns true the control
 * that had focus (or the trigger of the menu the dialog was opened from) is
 * recorded; when it turns false or the caller unmounts, focus goes back
 * there, or to `fallback` when that control is gone. */
export function useResearchDialogReturnFocus(
  open: boolean,
  fallback?: () => HTMLElement | null | undefined,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  // Read during render: the dialog's autofocus moves focus during the
  // commit, before any effect could see the opener.
  if (open && !wasOpenRef.current) {
    openerRef.current = researchFocusOrigin();
  }
  wasOpenRef.current = open;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    if (!open) return;
    return () => restoreResearchFocus(openerRef.current, () => fallbackRef.current?.());
  }, [open]);
}
