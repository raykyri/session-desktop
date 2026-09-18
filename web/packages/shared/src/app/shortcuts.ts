// The application chord table. One capture-phase listener in the client's
// `AppShell` feeds every keydown through `resolveAppShortcut`; nothing else
// interprets modifier chords, so the whole set is readable in one place and
// testable without a DOM (`07-client-architecture.md` §5).
//
// Every chord here is a research-surface command. The desktop's terminal,
// pane, split, and remote chords are gone with the surfaces they drove.

export type AppShortcutCommand =
  | { type: "focusResearchTab"; tabIndex: number }
  | { type: "focusResearchHome" }
  | { type: "cycleResearchTab"; direction: -1 | 1 }
  | { type: "moveResearchItem"; direction: -1 | 1 }
  | { type: "openSettings" }
  | { type: "openCommandPalette" }
  | { type: "toggleLeftSidebar" }
  | { type: "focusFollowups" }
  | { type: "openFolderMenu" }
  | { type: "toggleArtifactPanel" };

export interface AppShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  editableTarget?: boolean | undefined;
}

/** Hint label for the Home command. Browsers own Cmd-N and Cmd-T and never
 * deliver them to the page, so the hint advertises Shift-Cmd-H — the chord
 * that always reaches the app — even though Cmd-N/Cmd-T still resolve where a
 * host lets them through. */
export const RESEARCH_HOME_SHORTCUT_LABEL = "⇧⌘H";

function normalizedKey(key: string): string {
  switch (key.toLowerCase()) {
    case "{":
      return "[";
    case "}":
      return "]";
    default:
      return key.toLowerCase();
  }
}

export function resolveAppShortcut(input: AppShortcutInput): AppShortcutCommand | null {
  const key = normalizedKey(input.key);
  const command = input.metaKey;
  const control = input.ctrlKey;
  const option = input.altKey;
  const shift = input.shiftKey;
  const onePrimaryModifier = command !== control;

  if (
    command &&
    !control &&
    option &&
    !shift &&
    !input.editableTarget &&
    (key === "arrowup" || key === "arrowdown")
  ) {
    return { type: "moveResearchItem", direction: key === "arrowup" ? -1 : 1 };
  }
  if (onePrimaryModifier && !option && !shift && /^[1-9]$/.test(key)) {
    return { type: "focusResearchTab", tabIndex: Number(key) - 1 };
  }
  if (command && !control && !option && !shift && (key === "n" || key === "t")) {
    return { type: "focusResearchHome" };
  }
  // Added for the web: the browser keeps Cmd-N and Cmd-T for its own windows
  // and tabs, so Home needs a chord that survives to the page.
  if (command && !control && !option && shift && key === "h") {
    return { type: "focusResearchHome" };
  }
  if (command && !control && !option && shift && key === "g") {
    return { type: "toggleLeftSidebar" };
  }
  if (
    (!command && control && !option && key === "tab") ||
    (command && !control && !option && shift && (key === "[" || key === "]"))
  ) {
    const previous = key === "[" || (key === "tab" && shift);
    return { type: "cycleResearchTab", direction: previous ? -1 : 1 };
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
    return { type: "openFolderMenu" };
  }
  if (command && !control && !option && shift && key === "e") {
    return { type: "toggleArtifactPanel" };
  }
  return null;
}

/** Only the reorder command repeats while its chord is held; every other
 * command would fire a burst of navigations on key repeat. */
export function appShortcutAllowsRepeat(command: AppShortcutCommand): boolean {
  return command.type === "moveResearchItem";
}
