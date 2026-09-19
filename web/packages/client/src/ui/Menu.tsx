import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import { createContext, useContext } from "react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/cn.js";

import {
  MENU_ITEM,
  MENU_ITEM_SIZE,
  MENU_SEPARATOR,
  POPOVER_SURFACE,
  POPOVER_SURFACE_SIZE,
} from "./surfaces.js";

export type MenuSize = "sm" | "md";

const MenuSizeContext = createContext<MenuSize>("md");

export interface MenuProps {
  /** The element the menu hangs off. Base UI merges the trigger props onto it
   * through `render`, rather than wrapping it — a wrapper would nest a second
   * `role="button"` around the caller's own button. */
  trigger: ReactElement;
  children: ReactNode;
  /** Controlled open state; omit for an uncontrolled menu. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  triggerClassName?: string;
  /** Accessible name for the popup when the trigger is an icon button. */
  label?: string | undefined;
  /** `sm` matches a small trigger (`GHOST_TRIGGER`, small `ControlButton`). */
  size?: MenuSize;
}

/**
 * Dropdown menus (08 §4): tree row menus, the settings menu, journal card
 * menus. Base UI owns roving focus, typeahead, and Escape, so the desktop's
 * `clampContextMenuToViewport` math is gone (ADR-9).
 */
export function Menu({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  className,
  triggerClassName,
  label,
  size = "md",
}: MenuProps) {
  return (
    <MenuSizeContext.Provider value={size}>
      <BaseMenu.Root
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
      >
        <BaseMenu.Trigger className={triggerClassName} render={trigger} />
        <BaseMenu.Portal>
          <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="z-(--z-popover)">
            <BaseMenu.Popup
              className={cn(POPOVER_SURFACE, POPOVER_SURFACE_SIZE[size], "min-w-44", className)}
              {...(label === undefined ? {} : { "aria-label": label })}
            >
              {children}
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
    </MenuSizeContext.Provider>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  tone?: "default" | "danger";
  /** Right-aligned detail: a shortcut label or the current value. */
  hint?: ReactNode;
  className?: string;
  /** Keeps the menu open after activation (a toggle row). */
  closeOnClick?: boolean | undefined;
  /** The row is the current value: a leading check in the strong foreground.
   * `undefined` reserves no slot; a boolean reserves it so rows line up. */
  selected?: boolean | undefined;
}

export function MenuItem({
  children,
  onClick,
  disabled = false,
  tone = "default",
  hint,
  className,
  closeOnClick,
  selected,
}: MenuItemProps) {
  const size = useContext(MenuSizeContext);
  return (
    <BaseMenu.Item
      disabled={disabled}
      {...(closeOnClick === undefined ? {} : { closeOnClick })}
      onClick={onClick ? () => onClick() : undefined}
      aria-checked={selected}
      className={cn(
        MENU_ITEM,
        MENU_ITEM_SIZE[size],
        tone === "danger" && "text-danger-muted",
        className,
      )}
    >
      {selected === undefined ? null : (
        <span className="text-fg-strong inline-flex w-3 shrink-0 justify-center" aria-hidden="true">
          {selected ? <Check size={12} /> : null}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint === undefined ? null : (
        <span className="text-fg-muted ml-auto shrink-0 text-xs">{hint}</span>
      )}
    </BaseMenu.Item>
  );
}

export function MenuSeparator({ className }: { className?: string }) {
  return <BaseMenu.Separator className={cn(MENU_SEPARATOR, className)} />;
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.GroupLabel className="text-fg-subtle px-2.5 pt-2 pb-1 text-xs">
      {children}
    </BaseMenu.GroupLabel>
  );
}
