import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../lib/cn.js";
import { isApplePlatform } from "../lib/platform.js";

/**
 * Whether a composer keydown means "send": ⌘↵ on Apple platforms, Ctrl↵
 * elsewhere. A bare Enter inserts a newline. `isComposing` is checked first:
 * an IME confirming a candidate sends Enter, and treating that as submit posts
 * a half-typed sentence.
 */
export function isComposerSubmitShortcut(
  event: ReactKeyboardEvent,
  apple: boolean = isApplePlatform(),
): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  return apple ? event.metaKey : event.ctrlKey;
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
      <span aria-hidden="true" className="relative top-0.5">
        ↵
      </span>
    </span>
  );
}
