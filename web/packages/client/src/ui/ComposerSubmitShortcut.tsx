import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../lib/cn.js";
import { isApplePlatform } from "../lib/platform.js";

/**
 * Whether a composer keydown means "send": ⌘↵ on Apple platforms and Ctrl↵
 * elsewhere; a bare Enter inserts a newline (02 §5). `isComposing` is
 * checked first: an IME confirming a candidate sends Enter, and treating
 * that as submit posts a half-typed sentence.
 */
export function isComposerSubmitShortcut(
  event: ReactKeyboardEvent,
  apple: boolean = isApplePlatform(),
): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  return apple ? event.metaKey : event.ctrlKey;
}

/** The send chord as a tooltip writes it: "⌘↵" or "Ctrl+↵". */
export function composerSendChord(apple: boolean = isApplePlatform()): string {
  return apple ? "⌘↵" : "Ctrl+↵";
}

export function composerSubmitShortcutAriaLabel(apple: boolean = isApplePlatform()): string {
  return apple ? "Command Enter" : "Control Enter";
}

export function ComposerSubmitShortcutGlyph({
  className,
  ariaHidden = false,
}: {
  className?: string;
  ariaHidden?: boolean;
}) {
  const apple = isApplePlatform();
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs leading-none", className)}
      aria-hidden={ariaHidden ? "true" : undefined}
      aria-label={ariaHidden ? undefined : composerSubmitShortcutAriaLabel(apple)}
    >
      {apple ? "⌘" : "Ctrl"}
      <span aria-hidden="true" className="relative top-px">
        ↵
      </span>
    </span>
  );
}
