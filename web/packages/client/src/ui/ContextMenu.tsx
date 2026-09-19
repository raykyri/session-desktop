import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

import { CONTEXT_MENU_SURFACE, MENU_ITEM, MENU_ITEM_SIZE, MENU_SEPARATOR } from "./surfaces.js";

export interface ContextMenuProps {
  /** The region that owns the right-click. */
  children: ReactNode;
  items: ReactNode;
  className?: string;
  label?: string | undefined;
}

/**
 * Right-click menus (08 §4): link actions, sidebar rows, feed cards. The
 * library positions at the pointer and flips inside the viewport, which
 * replaces the desktop's `clampContextMenuToViewport`.
 */
export function ContextMenu({ children, items, className, label }: ContextMenuProps) {
  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger className="contents">{children}</BaseContextMenu.Trigger>
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner className="z-(--z-context-menu)">
          <BaseContextMenu.Popup
            className={cn(CONTEXT_MENU_SURFACE, "max-w-[calc(100vw-16px)] min-w-50", className)}
            {...(label === undefined ? {} : { "aria-label": label })}
          >
            {items}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}

export interface ContextMenuItemProps {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  icon?: ReactNode;
  tone?: "default" | "danger";
}

export function ContextMenuItem({
  children,
  onClick,
  disabled = false,
  icon,
  tone = "default",
}: ContextMenuItemProps) {
  return (
    <BaseContextMenu.Item
      disabled={disabled}
      onClick={onClick ? () => onClick() : undefined}
      className={cn(
        MENU_ITEM,
        MENU_ITEM_SIZE.md,
        "whitespace-nowrap",
        tone === "danger" && "text-danger-muted",
      )}
    >
      {icon}
      <span>{children}</span>
    </BaseContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <BaseContextMenu.Separator className={MENU_SEPARATOR} />;
}
