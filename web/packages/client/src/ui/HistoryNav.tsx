import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "../lib/cn.js";

import { IconButton } from "./Button.js";

export interface HistoryNavProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  className?: string;
  backLabel?: string;
  forwardLabel?: string;
}

/**
 * The back/forward pair in a stage header, ported from the desktop
 * `.research-history-nav`. Cross-page history is the browser's now (ADR-7), so
 * the header wires these to `router.history.back()/forward()`; inside a
 * research document the same component drives the per-node history stack.
 */
export function HistoryNav({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  className,
  backLabel = "Back",
  forwardLabel = "Forward",
}: HistoryNavProps) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <IconButton label={backLabel} disabled={!canGoBack} onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label={forwardLabel} disabled={!canGoForward} onClick={onForward}>
        <ChevronRight size={16} aria-hidden="true" />
      </IconButton>
    </div>
  );
}
