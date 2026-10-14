// The shortcut hints shown while the primary modifier is held (the desktop's
// `useShortcutHintsVisible` in `useAppKeyboard.ts`): ⌘ on Apple platforms,
// Ctrl elsewhere. The "Show keyboard shortcut hints" setting turns them off.

import { useEffect, useState } from "react";

import { useSettingsStore } from "../stores/settings.js";

import { isApplePlatform } from "./platform.js";

/** Whether the primary modifier is held. Released, a blurred window or a
 * hidden tab clears it, so a hint never stays after the key is let go
 * elsewhere. */
export function usePrimaryModifierHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const apple = isApplePlatform();
    const modifierKey = apple ? "Meta" : "Control";
    const pressed = (event: KeyboardEvent) => (apple ? event.metaKey : event.ctrlKey);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === modifierKey || pressed(event)) setHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === modifierKey || !pressed(event)) setHeld(false);
    };
    const release = () => setHeld(false);
    const onVisibility = () => {
      if (document.hidden) release();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return held;
}

/** Whether the shortcut hints show now: the setting is on and the primary
 * modifier is held. */
export function useShortcutHintsShown(): boolean {
  const enabled = useSettingsStore((state) => state.settings.showShortcutHints);
  const held = usePrimaryModifierHeld();
  return enabled && held;
}
