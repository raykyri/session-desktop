// Whether the primary modifier is held right now (`10` §7). The sidebar's
// shortcut badges appear while Cmd is down and the `showShortcutHints` setting
// is on, so the chords are discoverable without occupying the row all the time.
//
// `blur` clears the flag: a chord that switches windows (Cmd-Tab) never
// delivers its keyup, and a badge left showing after the window comes back is
// advertising a modifier nobody is holding.

import { useEffect, useState } from "react";

export function useModifierHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const sync = (event: KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, [enabled]);

  return enabled && held;
}
