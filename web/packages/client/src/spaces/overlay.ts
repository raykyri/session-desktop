// Popovers, sheets and dialogs as the mockup handles them: Escape closes the
// top one, and focus goes back to what opened it. A dialog with unsaved input
// asks before closing (the leave guard); Back in the browser closes an open
// dialog first (the mockup's overlay history). On Mobile Web, where menus,
// popovers and sheets cover the page, they get a history entry too, so Back
// closes them and the screen stays (phase 2 review round 1); on Desktop they
// are anchored to their button and stay out of history. A screen opened
// from inside an overlay takes the overlay's entry, so Back from it goes to
// the screen under the overlay, not to the overlay's copy of it.

import { useEffect, useRef } from "react";

const stack: { close: () => void }[] = [];

/** The Mobile Web layout (the mockup's phone width). */
export const mobileWeb = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(max-width: 640px)").matches;

const onOverlay = () => (history.state as { overlay?: boolean } | null)?.overlay === true;

// a navigation while an overlay's entry is the current one replaces that
// entry (the router pushes with `pushState`; an overlay's own push carries
// `overlay`)
if (typeof window !== "undefined" && typeof window.history?.pushState === "function") {
  const push = window.history.pushState.bind(window.history);
  window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    const ours = (data as { overlay?: boolean } | null)?.overlay === true;
    if (!ours && onOverlay()) window.history.replaceState(data, unused, url);
    else push(data, unused, url);
  };
}

/** While `open`: Escape closes it (the top of the stack only), and closing
 * returns focus to the element that had it when it opened. `back`: Back
 * closes it (a history entry); by default on Mobile Web only. */
// A dialog that replaces another (View your request, then Withdraw) keeps
// the history entry the first one added: the closing one leaves it for a
// moment, and the next one to open takes it over instead of adding another.
// Overlays that close together (a confirmation and the dialog under it) go
// back over all their entries at once.
let leaving: ReturnType<typeof setTimeout> | null = null;
let unwind = 0;

export function useOverlay(
  open: boolean,
  /** Answers false when it did not close (it asks first: unsaved input). */
  close: () => void | boolean,
  o: { back?: boolean } = {},
) {
  const back = o.back ?? mobileWeb();
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry = { close: () => closeRef.current() };
    stack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || stack[stack.length - 1] !== entry) return;
      e.preventDefault();
      e.stopPropagation();
      entry.close();
    };
    document.addEventListener("keydown", onKey, true);
    // Back closes a dialog: it adds a history entry that Back pops
    let popped = false;
    const onPop = () => {
      if (stack[stack.length - 1] !== entry) return;
      // Back stops at unsaved input: the entry comes back while the
      // confirmation is open, so the page stays as it was
      if (entry.close() === false) {
        history.pushState({ ...((history.state as object | null) ?? {}), overlay: true }, "");
        return;
      }
      popped = true;
    };
    if (back) {
      if (leaving !== null && unwind > 0) {
        // the entry of the one that just closed is this one's now
        unwind--;
        if (unwind === 0) {
          clearTimeout(leaving);
          leaving = null;
        }
      } else history.pushState({ ...((history.state as object | null) ?? {}), overlay: true }, "");
      window.addEventListener("popstate", onPop);
    }
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (back) {
        window.removeEventListener("popstate", onPop);
        if (!popped && onOverlay()) {
          unwind++;
          leaving ??= setTimeout(() => {
            const n = unwind;
            leaving = null;
            unwind = 0;
            if (n > 0 && onOverlay()) history.go(-n);
          }, 0);
        }
      }
      const k = stack.indexOf(entry);
      if (k >= 0) stack.splice(k, 1);
      if (opener && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Focus the first focusable element in `root` (a dialog that opened). */
export function focusFirst(root: HTMLElement | null) {
  const el = root?.querySelector<HTMLElement>(
    'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  );
  el?.focus();
}
