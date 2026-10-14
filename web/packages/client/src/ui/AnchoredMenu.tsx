// A menu opened by the caller rather than by a trigger of its own: a feed
// card's … button and its context menu open the same menu, at the button or at
// the pointer, and the Ask segment of the composer opens the model menu. The
// items are the `MenuItem`s of `Menu.tsx`, which render inside any Base UI
// menu.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

import { MenuSizeProvider, type MenuSize } from "./Menu.js";
import { POPOVER_SURFACE, POPOVER_SURFACE_SIZE } from "./surfaces.js";

/** An element, or a point (a right-click). */
export type MenuAnchor = HTMLElement | { x: number; y: number };

function anchorFor(anchor: MenuAnchor) {
  if (anchor instanceof HTMLElement) return anchor;
  return {
    getBoundingClientRect: () =>
      DOMRect.fromRect({ x: anchor.x, y: anchor.y, width: 0, height: 0 }),
  };
}

export function AnchoredMenu({
  anchor,
  label,
  onClose,
  children,
  side = "bottom",
  align = "start",
  size = "md",
  className,
}: {
  anchor: MenuAnchor;
  label: string;
  onClose: () => void;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  size?: MenuSize;
  className?: string;
}) {
  return (
    <MenuSizeProvider value={size}>
      <BaseMenu.Root
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {/* Base UI gives a menu its node in the floating tree from its
            trigger; without one, opening a submenu reads as a sibling menu
            opening and closes this menu. The trigger is never shown: the
            positioner's anchor places the menu. The popup is labelled by
            its trigger, so the trigger carries the menu's label. */}
        <BaseMenu.Trigger nativeButton={false} render={<span hidden aria-label={label} />} />
        <BaseMenu.Portal>
          <BaseMenu.Positioner
            anchor={anchorFor(anchor)}
            side={side}
            align={align}
            sideOffset={anchor instanceof HTMLElement ? 6 : 2}
            className="z-(--z-popover)"
          >
            <BaseMenu.Popup
              aria-label={label}
              className={cn(
                POPOVER_SURFACE,
                POPOVER_SURFACE_SIZE[size],
                "max-h-[min(70vh,var(--available-height))] min-w-52 overflow-y-auto",
                className,
              )}
              // Focus returns to the … button, or, for a context menu, to
              // what had it (Base UI's default).
              finalFocus={
                anchor instanceof HTMLElement ? () => (anchor.isConnected ? anchor : true) : true
              }
            >
              {children}
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
    </MenuSizeProvider>
  );
}
