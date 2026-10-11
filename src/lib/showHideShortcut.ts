// The system-wide show/hide shortcut setting: capturing an accelerator from a
// key press, and the status line shown under the field.
import type { ShowHideShortcutSetting } from "./api";

/** The key fields of a keydown event the capture reads. */
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Whether a key press goes to the show/hide shortcut field (marked
 * data-shortcut-capture="show-hide"), whose presses app shortcuts ignore. */
export function isShowHideShortcutCaptureTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("[data-shortcut-capture='show-hide']") !== null
  );
}

/** The accelerator name of the pressed key, or null for a modifier alone or
 * a key the accelerator syntax cannot name. */
export function shortcutKeyLabel(event: Pick<ShortcutKeyEvent, "key" | "code">): string | null {
  if (
    event.key === "Shift" ||
    event.key === "Control" ||
    event.key === "Alt" ||
    event.key === "Meta"
  ) {
    return null;
  }

  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return code;
  }

  switch (code) {
    case "Space":
    case "Enter":
    case "Tab":
    case "Backspace":
    case "Delete":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
    case "Insert":
    case "CapsLock":
      return code;
    case "Escape":
      return "Escape";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "NumpadAdd":
    case "NumpadDecimal":
    case "NumpadDivide":
    case "NumpadEnter":
    case "NumpadEqual":
    case "NumpadMultiply":
    case "NumpadSubtract":
      return code;
    case "AudioVolumeDown":
      return "VolumeDown";
    case "AudioVolumeUp":
      return "VolumeUp";
    case "AudioVolumeMute":
      return "VolumeMute";
    case "MediaPlayPause":
    case "MediaStop":
    case "MediaTrackNext":
    case "MediaTrackPrevious":
      return code;
    default:
      return null;
  }
}

/** The accelerator a key press names ("Control+Option+Shift+Command+Key"),
 * or an error when it has no modifier. Both are null for a modifier alone. */
export function shortcutFromKeyboardEvent(
  event: ShortcutKeyEvent,
): { accelerator: string | null; error: string | null } {
  const key = shortcutKeyLabel(event);
  if (!key) {
    return { accelerator: null, error: null };
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.altKey) {
    modifiers.push("Option");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Command");
  }
  if (modifiers.length === 0) {
    return {
      accelerator: null,
      error: "Use at least one modifier, such as Option or Command.",
    };
  }

  return { accelerator: [...modifiers, key].join("+"), error: null };
}

/** The status line under the field: the last error, or a note that a saved
 * shortcut is not registered (outside capture, which unregisters it). */
export function showHideShortcutMessage(setting: ShowHideShortcutSetting): string | null {
  return (
    setting.error ??
    (setting.accelerator && !setting.registered && !setting.captureActive
      ? "Shortcut is saved but not active."
      : null)
  );
}
