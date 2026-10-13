// The save shortcut of the editors that save explicitly (the editor column
// for documents and notes, and a draft's view). They are handled where the
// editor is focused, not by the app-level dispatcher (appShortcuts.ts), which
// binds no S chord.

/** The hint shown for isSaveShortcut. Like the app's other hints it names ⌘;
 * Ctrl+S does the same. */
export const SAVE_SHORTCUT_LABEL = "⌘S";

interface SaveShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** React's keyboard events carry the DOM event here. */
  nativeEvent?: { isComposing?: boolean };
}

/** ⌘S, or Ctrl+S: saves the open editor's text and keeps the editor open.
 * Exactly one of ⌘ and Ctrl must be held, as for Settings' ⌘, (Ctrl+,), so
 * the shortcut also works outside macOS; with Shift or Option held it does
 * not match. Keys pressed during input-method composition never match. */
export function isSaveShortcut(event: SaveShortcutInput): boolean {
  if (event.nativeEvent?.isComposing) {
    return false;
  }
  return event.metaKey !== event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s";
}
