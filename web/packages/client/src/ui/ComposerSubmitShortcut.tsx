import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../lib/cn.js";

/**
 * Whether a composer keydown means "send", ported from the desktop
 * `ComposerSubmitShortcut.tsx`. `isComposing` is checked first: an IME
 * confirming a candidate sends Enter, and treating that as submit posts a
 * half-typed sentence.
 */
export function isComposerSubmitShortcut(
  event: ReactKeyboardEvent,
  requireCmdEnter: boolean,
): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  if (requireCmdEnter) return event.metaKey;
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function composerSubmitShortcutAriaLabel(requireCmdEnter: boolean): string {
  return requireCmdEnter ? "Command Enter" : "Enter";
}

export function ComposerSubmitShortcutGlyph({
  requireCmdEnter,
  className,
  ariaHidden = false,
}: {
  requireCmdEnter: boolean;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs leading-none", className)}
      aria-hidden={ariaHidden ? "true" : undefined}
      aria-label={ariaHidden ? undefined : composerSubmitShortcutAriaLabel(requireCmdEnter)}
    >
      {requireCmdEnter ? "⌘" : null}
      <span aria-hidden="true">↵</span>
    </span>
  );
}
