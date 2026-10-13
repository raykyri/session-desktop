// Keys of the editors that save (the editor column for documents and notes,
// and a draft's view). They are handled where the editor is focused, not by
// the app-level dispatcher (appShortcuts.ts), which binds no S chord.

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
 * Exactly one of ⌘ and Ctrl, as Settings' ⌘, (Ctrl+,) accepts, so the key
 * works outside macOS; Shift and Option variants are not it. A key pressed
 * while an input method composes belongs to the composition. */
export function isSaveShortcut(event: SaveShortcutInput): boolean {
  if (event.nativeEvent?.isComposing) {
    return false;
  }
  return event.metaKey !== event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s";
}
