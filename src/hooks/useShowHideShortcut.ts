import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  getShowHideShortcut,
  setShowHideShortcut,
  setShowHideShortcutCaptureActive,
  type ShowHideShortcutSetting,
} from "../lib/api";
import { showHideShortcutConflict } from "@session/shared/lib/appShortcuts";
import { shortcutFromKeyboardEvent, showHideShortcutMessage } from "../lib/showHideShortcut";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The system-wide show/hide shortcut field of Settings. While the field has
 * focus the backend unregisters the shortcut (capture mode) so pressing it
 * records it instead of hiding the app; capture ends whenever Settings is
 * closed, including on mount.
 */
export function useShowHideShortcut(settingsOpen: boolean) {
  const [setting, setSetting] = useState<ShowHideShortcutSetting>({
    accelerator: null,
    registered: false,
    error: null,
    captureActive: false,
  });
  const [saving, setSaving] = useState(false);
  // Later requests supersede earlier ones; a stale response is dropped.
  const requestRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    void getShowHideShortcut()
      .then((loaded) => {
        if (!disposed) {
          setSetting(loaded);
        }
      })
      .catch((err) => {
        if (!disposed) {
          setSetting({
            accelerator: null,
            registered: false,
            error: errorMessage(err),
            captureActive: false,
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  const setCapturing = useCallback((active: boolean) => {
    const request = ++requestRef.current;
    setSetting((current) => ({ ...current, captureActive: active }));
    void setShowHideShortcutCaptureActive(active)
      .then((next) => {
        if (requestRef.current === request) {
          setSetting(next);
        }
      })
      .catch((err) => {
        if (requestRef.current === request) {
          setSetting((current) => ({
            ...current,
            captureActive: false,
            error: errorMessage(err),
          }));
        }
      });
  }, []);

  // Closing Settings can unmount the focused capture input without a reliable
  // blur event. Always restore the configured global shortcut in that case.
  useEffect(() => {
    if (!settingsOpen && setting.captureActive) {
      setCapturing(false);
    }
  }, [settingsOpen, setting.captureActive, setCapturing]);
  useEffect(() => {
    if (!settingsOpen) {
      setCapturing(false);
    }
  }, [settingsOpen, setCapturing]);

  const update = useCallback(async (accelerator: string | null) => {
    const request = ++requestRef.current;
    setSaving(true);
    setSetting((current) => ({ ...current, accelerator, error: null }));
    try {
      const next = await setShowHideShortcut(accelerator);
      if (requestRef.current === request) {
        setSetting(next);
      }
    } catch (err) {
      if (requestRef.current === request) {
        setSetting((current) => ({ ...current, error: errorMessage(err) }));
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const capture = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const { accelerator, error } = shortcutFromKeyboardEvent(event);
      if (error) {
        setSetting((current) => ({ ...current, error }));
        return;
      }
      if (accelerator) {
        void update(accelerator);
      }
    },
    [update],
  );

  const value = setting.accelerator ?? "";
  return {
    value,
    saving,
    message: showHideShortcutMessage(setting),
    // A system-wide hotkey consumes its chord before the app sees any key
    // event, so a registration that collides with an in-app shortcut silently
    // disables that command everywhere. Warn, don't block: the collision may
    // be wanted.
    conflictLabel: showHideShortcutConflict(value || null),
    capture,
    clear: () => void update(null),
    setCapturing,
  };
}
