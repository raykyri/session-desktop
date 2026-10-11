import { useEffect, type RefObject } from "react";

function focusConfirmDialogButton(button: HTMLButtonElement | null, force = false) {
  if (!button) {
    return;
  }
  const dialog = button.closest(".confirm-dialog");
  if (force || !dialog?.contains(document.activeElement)) {
    button.focus();
  }
}

/**
 * Focuses a confirmation dialog's default button whenever `trigger` changes
 * to a truthy value: at once, then again on the next frame and after 100ms
 * when focus is no longer inside the dialog.
 */
export function useConfirmDialogFocus(
  buttonRef: RefObject<HTMLButtonElement | null>,
  trigger: unknown,
): void {
  useEffect(() => {
    if (!trigger) {
      return;
    }
    const focus = (force = false) => focusConfirmDialogButton(buttonRef.current, force);
    focus(true);
    const frame = requestAnimationFrame(() => focus());
    const settle = window.setTimeout(() => focus(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [buttonRef, trigger]);
}
