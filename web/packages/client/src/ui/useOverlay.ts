import { useEffect, useId, useRef } from "react";

import { useOverlaysStore } from "../stores/overlays.js";

/**
 * Registers a non-library dismissable layer on the escape stack for as long as
 * `active` is true (07 §4.4). Base UI handles Escape for its own dialogs,
 * menus and popovers; this is for the layers it does not own — lightboxes, the
 * DOM search bar, the selection popover, sidebar multi-select.
 *
 * The callback is held in a ref so a layer that re-renders with a new closure
 * does not re-register and jump to the top of its priority band.
 */
export function useOverlay(active: boolean, priority: number, onEscape: () => void): void {
  const id = useId();
  const handler = useRef(onEscape);

  useEffect(() => {
    handler.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const { register, unregister } = useOverlaysStore.getState();
    register(id, priority, () => handler.current());
    return () => unregister(id);
  }, [active, id, priority]);
}
