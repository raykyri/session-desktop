export type WindowFocusKeyboardOwner =
  | "current-web-editable"
  | "remembered-web-editable"
  | "current-content";

/** Distinguishes a real app reactivation from WebKit first-responder churn.
 * A remembered editor is restored only when the whole app is returning; on an
 * internal webview focus event the current content keeps ownership. */
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
