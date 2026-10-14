// App-level keyboard handling: the Escape dispatcher, the ⌘-held shortcut
// hints, and the app shortcuts (from the DOM and from the native menu).
// App calls these in this order, which is also the order of their
// capture-phase window listeners.
import { useCallback, useEffect, useRef, useState } from "react";
import { closeDiagramLightbox, getDiagramLightbox } from "../lib/diagramLightbox";
import { closeImageLightbox, getImageLightbox } from "../lib/imageLightbox";
import { resolveAppShortcut, type AppShortcutCommand } from "@session/shared/lib/appShortcuts";
import {
  requestResearchFollowupsFocus,
  requestResearchWorkspaceMenuToggle,
} from "../lib/researchShortcuts";
import { isShowHideShortcutCaptureTarget } from "../lib/showHideShortcut";

/** The app-level overlays Escape closes, as of the last render. */
interface EscapeOverlayState {
  researchFolderRemoval: unknown;
  exitDialog: unknown;
  renameGroupId: string | null;
  removingResearchFolder: boolean;
  settingsOpen: boolean;
  agentsOpen: boolean;
  error: string | null;
}

interface EscapeHandlers {
  /** Closes the browser overlay's top layer; true when it handled Escape. */
  closeBrowserOnEscape: () => boolean;
  closeResearchFolderRemoval: () => void;
  cancelExit: () => void;
  closeSettings: () => void;
  closeAgentSetup: () => void;
  dismissError: () => void;
}

/**
 * Dispatches Escape across the app-level overlays in a fixed order through
 * one capture-phase listener. Returns the dispatcher for the lightboxes and
 * the browser overlay, which the native Escape monitor calls too.
 */
export function useEscapeDispatcher(overlays: EscapeOverlayState, handlers: EscapeHandlers) {
  // Live snapshot of the overlay state for the listener below, which is
  // registered exactly once. Mirrored every render, read only at event time.
  const overlaysRef = useRef(overlays);
  useEffect(() => {
    overlaysRef.current = overlays;
  });
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Escape can originate in two separate AppKit responders while the browser
  // is visible: the outer app webview and the child human-browser WKWebView.
  // The native monitor sends both through this dispatcher. The DOM listener
  // uses the same dispatcher to preserve lightbox/browser priority.
  const dispatchBrowserEscape = useCallback((): "exclusive" | null => {
    if (getImageLightbox() !== null) {
      closeImageLightbox();
      return "exclusive";
    }
    if (getDiagramLightbox() !== null) {
      closeDiagramLightbox();
      return "exclusive";
    }
    return handlersRef.current.closeBrowserOnEscape() ? "exclusive" : null;
  }, []);

  // One capture-phase listener dispatches Escape across the app-level
  // overlays in a fixed order. These used to be independent window listeners
  // whose effects re-registered when their deps changed, so their relative
  // position in the same-target capture order silently followed registration
  // history. State lives in the ref above so this listener never re-registers,
  // and handlers run in the fixed order below.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Native modal dialogs own Escape and focus while they are open.
      if (document.querySelector("dialog[open]")) return;
      const state = overlaysRef.current;
      const actions = handlersRef.current;

      const browserEscapeDisposition = dispatchBrowserEscape();
      if (browserEscapeDisposition !== null) {
        event.preventDefault();
        event.stopPropagation();
        if (browserEscapeDisposition === "exclusive") {
          event.stopImmediatePropagation();
        }
        return;
      }

      // The remaining overlays dismiss together on one Escape, as they did as
      // independent listeners that each observed the same keydown.
      const dialogsOpen = Boolean(state.researchFolderRemoval || state.exitDialog);
      let stopPropagation = false;
      if (dialogsOpen) {
        stopPropagation = true;
        event.preventDefault();
        // Don't dismiss the removal dialog while the removal is running.
        if (!state.removingResearchFolder) {
          actions.closeResearchFolderRemoval();
        }
        actions.cancelExit();
      }
      if (state.settingsOpen) {
        stopPropagation = true;
        event.preventDefault();
        actions.closeSettings();
      }
      if (state.agentsOpen) {
        stopPropagation = true;
        event.preventDefault();
        actions.closeAgentSetup();
      }
      // Dismiss the workspace error banner with Escape only when no dialog or
      // rename editor is handling the key.
      if (state.error && !dialogsOpen && !state.renameGroupId) {
        stopPropagation = true;
        event.preventDefault();
        actions.dismissError();
      }
      if (stopPropagation) {
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [dispatchBrowserEscape]);

  return dispatchBrowserEscape;
}

/** Whether ⌘ is held, which shows the shortcut hints. */
export function useShortcutHintsVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.metaKey) {
        setVisible(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta" || !event.metaKey) {
        setVisible(false);
      }
    };
    const hideShortcutHints = () => setVisible(false);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hideShortcutHints();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", hideShortcutHints);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", hideShortcutHints);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
  return visible;
}

interface AppShortcutActions {
  focusResearchHome: () => void;
  toggleSidebar: () => void;
  openSettings: () => void;
  openCommandPalette: () => void;
  toggleSourceBrowser: () => void;
}

/**
 * Runs the app shortcuts from keydown and returns the handler for the same
 * commands sent by the native menu.
 */
export function useAppShortcuts({
  focusResearchHome,
  toggleSidebar,
  openSettings,
  openCommandPalette,
  toggleSourceBrowser,
}: AppShortcutActions) {
  const nativeHandlerRef = useRef<(command: AppShortcutCommand, repeat: boolean) => void>(
    () => undefined,
  );
  const handleNativeAppShortcut = useCallback(
    (command: AppShortcutCommand, repeat: boolean) => {
      nativeHandlerRef.current(command, repeat);
    },
    [],
  );

  useEffect(() => {
    const executeShortcut = (command: AppShortcutCommand, repeat: boolean) => {
      if (document.querySelector("dialog[open]")) return;
      // No app command repeats while its chord is held.
      if (repeat) {
        return;
      }
      switch (command.type) {
        case "focusResearchHome":
          focusResearchHome();
          window.requestAnimationFrame(() => {
            document
              .querySelector<HTMLTextAreaElement>(".new-research-launcher textarea")
              ?.focus();
          });
          return;
        case "toggleLeftSidebar":
          toggleSidebar();
          return;
        case "openSettings":
          openSettings();
          return;
        case "openCommandPalette":
          openCommandPalette();
          return;
        case "focusFollowups":
          requestResearchFollowupsFocus();
          return;
        case "openFolderMenu":
          requestResearchWorkspaceMenuToggle();
          return;
        case "toggleSourceBrowser":
          toggleSourceBrowser();
          return;
      }
    };

    nativeHandlerRef.current = executeShortcut;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShowHideShortcutCaptureTarget(event.target) || event.defaultPrevented) {
        return;
      }
      const command = resolveAppShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      if (!command) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      executeShortcut(command, event.repeat);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      nativeHandlerRef.current = () => undefined;
    };
  }, [focusResearchHome, openCommandPalette, openSettings, toggleSidebar, toggleSourceBrowser]);

  return handleNativeAppShortcut;
}
