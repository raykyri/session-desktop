// The application chord table. One capture-phase listener in the client's
// `AppShell` feeds every keydown through `resolveAppShortcut`; nothing else
// interprets modifier chords, so the whole set is readable in one place and
// testable without a DOM (`07-client-architecture.md` §5).
//
// The chords are the desktop's (`lib/appShortcuts.ts`) that have a surface on
// the web, plus Shift-Cmd-H for Home. The desktop's source browser chord
// (Shift-Cmd-E) is gone with the browser. Every chord here also works from a
// text field: Cmd-J ("focus the follow-ups") exists precisely to be pressed
// from one.

export type AppShortcutCommand =
  | { type: "focusResearchHome" }
  | { type: "openSettings" }
  | { type: "openCommandPalette" }
  | { type: "toggleLeftSidebar" }
  | { type: "focusFollowups" }
  | { type: "openWorkspaceMenu" };

export interface AppShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Display shortcut label for Home. Uses Shift-Cmd-H by default since standard browser shortcuts (Cmd-N/Cmd-T) are intercepted by web browsers. */
export const RESEARCH_HOME_SHORTCUT_LABEL = "⇧⌘H";

export function resolveAppShortcut(input: AppShortcutInput): AppShortcutCommand | null {
  const key = input.key.toLowerCase();
  const command = input.metaKey;
  const control = input.ctrlKey;
  const option = input.altKey;
  const shift = input.shiftKey;
  const onePrimaryModifier = command !== control;

  if (command && !control && !option && !shift && (key === "n" || key === "t")) {
    return { type: "focusResearchHome" };
  }
  // Added for the web: the browser keeps Cmd-N and Cmd-T for its own windows
  // and tabs, so Home needs a chord that reaches the page.
  if (command && !control && !option && shift && key === "h") {
    return { type: "focusResearchHome" };
  }
  if (command && !control && !option && shift && key === "g") {
    return { type: "toggleLeftSidebar" };
  }
  if (onePrimaryModifier && !option && !shift && key === ",") {
    return { type: "openSettings" };
  }
  if (command && !control && !option && !shift && key === "k") {
    return { type: "openCommandPalette" };
  }
  if (command && !control && !option && !shift && key === "j") {
    return { type: "focusFollowups" };
  }
  if (command && !control && !option && !shift && key === "o") {
    return { type: "openWorkspaceMenu" };
  }
  return null;
}
