// Popovers, sheets and dialogs as the mockup handles them: Escape closes the
// top one, and focus goes back to what opened it. A dialog with unsaved input
// asks before closing (the leave guard); Back in the browser closes an open
// dialog first (the mockup's overlay history).

import { useEffect, useRef } from "react";

const stack: { close: () => void }[] = [];

/** While `open`: Escape closes it (the top of the stack only), and closing
 * returns focus to the element that had it when it opened. */
export function useOverlay(open: boolean, close: () => void, o: { back?: boolean } = {}) {
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
      popped = true;
      entry.close();
    };
    if (o.back) {
      history.pushState({ ...((history.state as object | null) ?? {}), overlay: true }, "");
      window.addEventListener("popstate", onPop);
    }
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (o.back) {
        window.removeEventListener("popstate", onPop);
        if (!popped && (history.state as { overlay?: boolean } | null)?.overlay) history.back();
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
