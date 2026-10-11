import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  setNativeBrowserBackground,
  setOpenRouterKey,
  setResearchInlineWidgets,
  setResearchLaunchInstruction,
  setUseLoginShell,
  setWorktreeLocation,
} from "../lib/api";
import { IS_MAC } from "../lib/appHelpers";
import {
  bodyFontStackFor,
  clampResearchLaunchInstruction,
  DEFAULT_BODY_FONT_ID,
  detectAvailableBodyFonts,
  loadSettings,
  saveSettings,
  SYSTEM_BODY_FONT_ID,
  type AppSettings,
  type BodyFontOption,
  type WorktreeLocation,
} from "../lib/settings";

/** The preferences whose durable copy lives in the backend, read at startup. */
interface StoredPreferences {
  storedOpenRouterKey: string;
  storedUseLoginShell: boolean | null;
  storedWorktreeLocation: WorktreeLocation | null;
  storedResearchLaunchInstruction: string | null;
  storedResearchInlineWidgets: boolean | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Application settings: loaded from localStorage on mount and saved on every
 * change. The OpenRouter key, the login-shell choice, the worktree location
 * and the research instructions are also mirrored to the backend, which owns
 * their durable copy, once `applyStoredPreferences` has hydrated them from it.
 * Also applies the appearance, color theme and body font to the document.
 */
export function useAppSettings(onError: (message: string) => void) {
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...loadSettings(),
    codeMode: false,
  }));
  const [availableBodyFonts, setAvailableBodyFonts] = useState<BodyFontOption[] | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Set once the backend copies are loaded, so the synchronization effects do not write
  // the pre-hydration localStorage values back over them.
  const openRouterKeyHydratedRef = useRef(false);
  const useLoginShellHydratedRef = useRef(false);
  const worktreeLocationHydratedRef = useRef(false);
  const researchLaunchInstructionHydratedRef = useRef(false);
  const researchInlineWidgetsHydratedRef = useRef(false);

  const bodyFontFamily = bodyFontStackFor(settings.bodyFontId);
  // Apply the app accent before paint so switching (and restoring) color themes
  // does not flash the default green palette.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.colorTheme = settings.colorTheme;
    return () => {
      delete root.dataset.colorTheme;
    };
  }, [settings.colorTheme]);

  // Light/dark is independent of the system appearance. The root attribute
  // drives every token override; the window theme synchronizes native pieces
  // that CSS cannot reach (sidebar vibrancy material, prefers-color-scheme
  // inside sandboxed preview iframes, native form controls and scrollbars).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = settings.appearance;
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow().setTheme(settings.appearance).catch(() => undefined);
    }
    return () => {
      delete root.dataset.appearance;
    };
  }, [settings.appearance]);
  const toggleAppearance = useCallback(() => {
    setSettings((current) => ({
      ...current,
      appearance: current.appearance === "light" ? "dark" : "light",
    }));
  }, []);

  // The selected body font must live at the document root, not only on
  // .app-shell: menus and dialogs are portaled to document.body to escape pane
  // clipping, and CSS inheritance follows their DOM parent rather than their
  // React owner. Keeping the root variable current makes those surfaces follow
  // the same font selection as the rest of the application. data-body-font
  // drives optical text offsets for fonts that sit high in control boxes.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-ui", bodyFontFamily);
    root.dataset.bodyFont = settings.bodyFontId;
    return () => {
      root.style.removeProperty("--font-ui");
      delete root.dataset.bodyFont;
    };
  }, [bodyFontFamily, settings.bodyFontId]);

  useEffect(() => {
    let disposed = false;
    void detectAvailableBodyFonts().then((availableFonts) => {
      if (disposed) {
        return;
      }

      setAvailableBodyFonts(availableFonts);
      setSettings((current) => {
        if (availableFonts.some((option) => option.id === current.bodyFontId)) {
          return current;
        }
        const fallbackBodyFontId =
          availableFonts.find((option) => option.id === DEFAULT_BODY_FONT_ID)?.id ??
          availableFonts.find((option) => option.id === SYSTEM_BODY_FONT_ID)?.id ??
          DEFAULT_BODY_FONT_ID;
        return { ...current, bodyFontId: fallbackBodyFontId };
      });
    });

    return () => {
      disposed = true;
    };
  }, []);

  // Match the native loading canvas to the app's document surface.
  useLayoutEffect(() => {
    if (!IS_MAC) return;
    const value = getComputedStyle(document.documentElement).getPropertyValue("--terminal-pane-bg").trim();
    const color = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
    if (color) {
      void setNativeBrowserBackground(...[0, 2, 4].map((offset) =>
        parseInt(color.slice(offset, offset + 2), 16) / 255,
      ) as [number, number, number]).catch(() => undefined);
    }
  }, [settings.colorTheme, settings.appearance]);

  // Persist application settings whenever they change, so the choice survives a
  // restart. Writing on the initial value is harmless.
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // The OpenRouter key's durable, owner-only home is the backend.
  useEffect(() => {
    if (!openRouterKeyHydratedRef.current) {
      return;
    }
    void setOpenRouterKey(settings.openRouterKey).catch(() => undefined);
  }, [settings.openRouterKey]);

  // The backend stores the login-shell preference for the spawn path, including
  // startup recovery that runs before this fires.
  useEffect(() => {
    if (!useLoginShellHydratedRef.current) {
      return;
    }
    void setUseLoginShell(settings.useLoginShell).catch((err) => {
      onErrorRef.current(`Could not save the login-shell setting: ${errorMessage(err)}`);
    });
  }, [settings.useLoginShell]);

  // The backend owns this preference because worktrees can also be created by
  // CLI/control-socket and queued forks without a frontend request in flight.
  useEffect(() => {
    if (!worktreeLocationHydratedRef.current) {
      return;
    }
    void setWorktreeLocation(settings.worktreeLocation).catch((err) => {
      onErrorRef.current(`Could not save the worktree-location setting: ${errorMessage(err)}`);
    });
  }, [settings.worktreeLocation]);

  // Research launch prompts (fresh runs and every follow-up kind) are
  // assembled on the Rust side.
  useEffect(() => {
    if (!researchLaunchInstructionHydratedRef.current) {
      return;
    }
    void setResearchLaunchInstruction(settings.researchLaunchInstruction).catch((err) => {
      onErrorRef.current(
        `Could not save the research-instructions setting: ${errorMessage(err)}`,
      );
    });
  }, [settings.researchLaunchInstruction]);

  // Research launches read the widget preference on the Rust side to decide
  // whether agents receive the widget guidance.
  useEffect(() => {
    if (!researchInlineWidgetsHydratedRef.current) {
      return;
    }
    void setResearchInlineWidgets(settings.researchInlineWidgets).catch((err) => {
      onErrorRef.current(`Could not save the inline-widgets setting: ${errorMessage(err)}`);
    });
  }, [settings.researchInlineWidgets]);

  // Hydrates the backend-owned preferences. If the backend has no OpenRouter
  // key but one survives in an old localStorage settings blob, that value is
  // migrated into the backend once; either way the in-memory settings track it.
  const applyStoredPreferences = useCallback(
    ({
      storedOpenRouterKey,
      storedUseLoginShell,
      storedWorktreeLocation,
      storedResearchLaunchInstruction,
      storedResearchInlineWidgets,
    }: StoredPreferences) => {
      setSettings((current) => {
        const backendKey = storedOpenRouterKey.trim();
        const migratedKey = current.openRouterKey.trim();
        const effectiveKey = backendKey || migratedKey;
        const effectiveUseLoginShell = storedUseLoginShell ?? current.useLoginShell;
        const effectiveWorktreeLocation = storedWorktreeLocation ?? current.worktreeLocation;
        const effectiveResearchLaunchInstruction = clampResearchLaunchInstruction(
          storedResearchLaunchInstruction ?? current.researchLaunchInstruction,
        );
        const effectiveResearchInlineWidgets =
          storedResearchInlineWidgets ?? current.researchInlineWidgets;
        // Never stored in the backend (which then defaults to on): record the
        // local choice so launches follow what the dialog shows.
        if (storedResearchInlineWidgets === null) {
          void setResearchInlineWidgets(effectiveResearchInlineWidgets).catch(() => undefined);
        }
        if (!backendKey && migratedKey) {
          void setOpenRouterKey(migratedKey).catch(() => undefined);
        }
        openRouterKeyHydratedRef.current = true;
        useLoginShellHydratedRef.current = true;
        worktreeLocationHydratedRef.current = true;
        researchLaunchInstructionHydratedRef.current = true;
        researchInlineWidgetsHydratedRef.current = true;
        return current.openRouterKey === effectiveKey &&
          current.useLoginShell === effectiveUseLoginShell &&
          current.worktreeLocation === effectiveWorktreeLocation &&
          current.researchLaunchInstruction === effectiveResearchLaunchInstruction &&
          current.researchInlineWidgets === effectiveResearchInlineWidgets
          ? current
          : {
              ...current,
              openRouterKey: effectiveKey,
              useLoginShell: effectiveUseLoginShell,
              worktreeLocation: effectiveWorktreeLocation,
              researchLaunchInstruction: effectiveResearchLaunchInstruction,
              researchInlineWidgets: effectiveResearchInlineWidgets,
            };
      });
    },
    [],
  );

  return {
    settings,
    setSettings,
    availableBodyFonts,
    bodyFontFamily,
    toggleAppearance,
    applyStoredPreferences,
  };
}
