import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../lib/cn.js";
import { isApplePlatform } from "../lib/platform.js";
import { useSettingsStore } from "../stores/settings.js";

/**
 * Whether a composer keydown means "send". With `requireCmdEnter` (the
 * default, and always in a thread's ask boxes) that is ⌘↵ on Apple
 * platforms and Ctrl↵ elsewhere, and a bare Enter inserts a newline; without
 * it a bare Enter sends and Shift+Enter inserts the newline, as the
 * desktop's "Require ⌘↵ to send" setting does. `isComposing` is checked
 * first: an IME confirming a candidate sends Enter, and treating that as
 * submit posts a half-typed sentence.
 */
export function isComposerSubmitShortcut(
  event: ReactKeyboardEvent,
  apple: boolean = isApplePlatform(),
  requireCmdEnter = true,
): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  if (!requireCmdEnter) {
    return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }
  return apple ? event.metaKey : event.ctrlKey;
}

/** The "Require ⌘↵ to send" setting, for the ask boxes it governs (all but
 * a thread's). */
export function useRequireCmdEnterToSend(): boolean {
  return useSettingsStore((state) => state.settings.requireCmdEnterToSend);
}

/** The send chord as a tooltip writes it: "⌘↵", "Ctrl+↵", or "↵". */
export function composerSendChord(
  requireCmdEnter = true,
  apple: boolean = isApplePlatform(),
): string {
  if (!requireCmdEnter) return "↵";
  return apple ? "⌘↵" : "Ctrl+↵";
}

export function composerSubmitShortcutAriaLabel(
  apple: boolean = isApplePlatform(),
  requireCmdEnter = true,
): string {
  if (!requireCmdEnter) return "Enter";
  return apple ? "Command Enter" : "Control Enter";
}

export function ComposerSubmitShortcutGlyph({
  className,
  ariaHidden = false,
  requireCmdEnter = true,
}: {
  className?: string;
  ariaHidden?: boolean;
  requireCmdEnter?: boolean;
}) {
  const apple = isApplePlatform();
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs leading-none", className)}
      aria-hidden={ariaHidden ? "true" : undefined}
      aria-label={ariaHidden ? undefined : composerSubmitShortcutAriaLabel(apple, requireCmdEnter)}
    >
      {requireCmdEnter ? (apple ? "⌘" : "Ctrl") : null}
      <span aria-hidden="true" className="relative top-px">
        ↵
      </span>
    </span>
  );
}
