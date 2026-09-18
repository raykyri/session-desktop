import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface TooltipProps {
  /** The control the tip describes. Substituted into `Tooltip.Trigger` through
   * `render` so the tip's aria wiring lands on the control itself. */
  children: ReactElement;
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  /** Milliseconds before the tip appears. The default matches a `title`
   * attribute closely enough that replacing one with a Tooltip does not change
   * how the control feels. */
  delay?: number;
}

/** Wraps a control in a tooltip (08 §4), replacing bare `title` attributes,
 * which screen readers announce inconsistently and touch devices never show. */
export function Tooltip({ children, content, side = "top", className, delay = 600 }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={delay} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-(--z-popover)">
          <BaseTooltip.Popup
            className={cn(
              "border-border-divider bg-surface-popover rounded-md border px-2 py-1",
              "text-fg-primary shadow-popover text-xs",
              className,
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** Mounted once near the app root so a tip that follows another opens without
 * re-paying the delay. */
export const TooltipProvider = BaseTooltip.Provider;
