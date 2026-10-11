import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isEditableTarget } from "../lib/appHelpers";
import { windowFocusKeyboardOwner } from "../lib/windowFocus";

/**
 * Returns keyboard focus to the web editable (composer, rename input, search
 * field…) that held it when the native app window deactivated.
 *
 * WebKit can replace `document.activeElement` with `<body>` while the window
 * deactivates, so the editable is recorded from focus events rather than read
 * back on reactivation. Focus-in records the editable synchronously from the
 * event target; focus-out and window focus changes sample one frame later,
 * after `activeElement` settles.
 */
export function useEditableFocusRestore(): void {
  // Whether a web editable holds DOM focus, sampled from focus events.
  const webEditableFocusedRef = useRef(false);
  // The editable most recently focused, and the one focused when the native
  // window last deactivated.
  const lastFocusedWebEditableRef = useRef<HTMLElement | null>(null);
  const appBlurWebEditableRef = useRef<HTMLElement | null>(null);
  const nativeWindowFocusedRef = useRef(true);

  useEffect(() => {
    let frame: number | null = null;
    let restoreFrame: number | null = null;
    let restoringRememberedEditable = false;
    let disposed = false;
    let unlistenNativeFocus: (() => void) | undefined;
    const restorableEditable = (target: HTMLElement | null) =>
      Boolean(
        target &&
          target.isConnected &&
          isEditableTarget(target) &&
          !target.matches(":disabled"),
      );
    const sample = () => {
      frame = null;
      webEditableFocusedRef.current =
        document.hasFocus() && isEditableTarget(document.activeElement);
    };
    const schedule = () => {
      if (frame === null) {
        frame = requestAnimationFrame(sample);
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      const editable = document.hasFocus() && isEditableTarget(event.target);
      if (editable && event.target instanceof HTMLElement) {
        lastFocusedWebEditableRef.current = event.target;
      }
      webEditableFocusedRef.current = editable;
    };
    const restoreWindowEditable = (returningToApp: boolean) => {
      const active =
        document.activeElement instanceof HTMLElement &&
        isEditableTarget(document.activeElement)
          ? document.activeElement
          : null;
      const remembered = appBlurWebEditableRef.current;
      const owner = windowFocusKeyboardOwner({
        currentWebEditable: active !== null,
        rememberedWebEditable: restorableEditable(remembered),
        returningToApp: returningToApp || restoringRememberedEditable,
      });
      if (owner === "current-web-editable") {
        lastFocusedWebEditableRef.current = active;
        webEditableFocusedRef.current = true;
        return true;
      }
      if (owner !== "remembered-web-editable" || !remembered) {
        restoringRememberedEditable = false;
        return false;
      }
      // Focus both now and on the next frame: Tauri can announce native
      // activation just before WKWebView is ready to accept first responder
      // again.
      restoringRememberedEditable = true;
      lastFocusedWebEditableRef.current = remembered;
      webEditableFocusedRef.current = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      remembered.focus({ preventScroll: true });
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame);
      }
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        if (!restorableEditable(remembered)) {
          appBlurWebEditableRef.current = null;
          restoringRememberedEditable = false;
          sample();
          return;
        }
        if (document.activeElement !== remembered) {
          remembered.focus({ preventScroll: true });
        }
        restoringRememberedEditable = false;
        sample();
      });
      return true;
    };
    const handleWindowFocus = () => {
      const returningToApp = !nativeWindowFocusedRef.current;
      schedule();
      restoreWindowEditable(returningToApp);
    };
    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("focusout", schedule);
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", handleWindowFocus);
    // WebKit emits no focusout when a focused element's subtree is removed,
    // so the sample can stay true with focus back on <body>. Re-sampling on
    // keys and clicks (rAF-coalesced) corrects it on the next interaction.
    window.addEventListener("keydown", schedule, true);
    window.addEventListener("pointerdown", schedule, true);
    const appWindow = getCurrentWindow();
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        nativeWindowFocusedRef.current = focused;
        if (!focused) {
          appBlurWebEditableRef.current = webEditableFocusedRef.current
            ? lastFocusedWebEditableRef.current
            : null;
          return;
        }
        if (!restoreWindowEditable(true)) {
          schedule();
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenNativeFocus = unlisten;
        }
      })
      .catch(() => undefined);
    sample();
    return () => {
      disposed = true;
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("keydown", schedule, true);
      window.removeEventListener("pointerdown", schedule, true);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame);
      }
      unlistenNativeFocus?.();
    };
  }, []);
}
