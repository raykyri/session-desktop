import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/cn.js";

import { POPOVER_SURFACE } from "./surfaces.js";

export interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  triggerClassName?: string;
  label?: string | undefined;
}

/**
 * Anchored non-menu layers (08 §4): the selection action popover, the folder
 * switcher. Base UI's positioner replaces the desktop's `placePanePopover`
 * measurement (ADR-9).
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  className,
  triggerClassName,
  label,
}: PopoverProps) {
  return (
    <BasePopover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <BasePopover.Trigger className={triggerClassName} render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          className="z-(--z-popover)"
        >
          <BasePopover.Popup
            className={cn(POPOVER_SURFACE, "p-3", className)}
            {...(label === undefined ? {} : { "aria-label": label })}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
