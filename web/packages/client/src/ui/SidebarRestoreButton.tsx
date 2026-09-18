import { PanelLeftOpen } from "lucide-react";

import { cn } from "../lib/cn.js";

import { IconButton } from "./Button.js";

export interface SidebarRestoreButtonProps {
  onRestore: () => void;
  className?: string;
  /** Rendered next to the icon so the chord stays discoverable while the
   * sidebar — where the hint normally lives — is hidden. */
  shortcutLabel?: string;
}

/** The affordance that brings a collapsed sidebar back, ported from the
 * desktop's `sidebarControls`. */
export function SidebarRestoreButton({
  onRestore,
  className,
  shortcutLabel = "⇧⌘G",
}: SidebarRestoreButtonProps) {
  return (
    <IconButton
      label="Show sidebar"
      title={`Show sidebar (${shortcutLabel})`}
      onClick={onRestore}
      className={cn("size-control-md", className)}
    >
      <PanelLeftOpen size={16} aria-hidden="true" />
    </IconButton>
  );
}
