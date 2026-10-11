type WindowFocusKeyboardOwner =
  | "current-web-editable"
  | "remembered-web-editable"
  | "current-content";

/** Distinguishes app reactivation from WebKit first-responder changes.
 * Restore a remembered editor only when the app returns to the foreground;
 * leave an internal webview focus event with the current content. */
export function windowFocusKeyboardOwner({
  currentWebEditable,
  rememberedWebEditable,
  returningToApp,
}: {
  currentWebEditable: boolean;
  rememberedWebEditable: boolean;
  returningToApp: boolean;
}): WindowFocusKeyboardOwner {
  if (currentWebEditable) {
    return "current-web-editable";
  }
  if (returningToApp && rememberedWebEditable) {
    return "remembered-web-editable";
  }
  return "current-content";
}
