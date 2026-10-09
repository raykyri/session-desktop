export type AppShortcutCommand =
  | { type: "focusResearchHome" }
  | { type: "openSettings" }
  | { type: "openCommandPalette" }
  | { type: "toggleLeftSidebar" }
  | { type: "focusFollowups" }
  | { type: "openFolderMenu" }
  | { type: "toggleSourceBrowser" };

interface AppShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  terminalTarget?: boolean;
}

export const RESEARCH_HOME_SHORTCUT_LABEL = "⌘N";

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
    return { type: "openFolderMenu" };
  }
  if (command && !control && !option && shift && key === "e") {
    return { type: "toggleSourceBrowser" };
  }
  return null;
}

function appShortcutLabel(command: AppShortcutCommand): string {
  switch (command.type) {
    case "focusResearchHome":
      return "open Home";
    case "openSettings":
      return "open settings";
    case "openCommandPalette":
      return "open the command palette";
    case "toggleLeftSidebar":
      return "toggle the sidebar";
    case "focusFollowups":
      return "jump to the follow-ups";
    case "openFolderMenu":
      return "open the research workspace menu";
    case "toggleSourceBrowser":
      return "toggle the source browser";
    default:
      return "run an app command";
  }
}

function acceleratorToShortcutInput(accelerator: string): AppShortcutInput | null {
  const parts = accelerator.split("+").map((part) => part.trim());
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set(parts);
  const namedKeys: Record<string, string> = {
    Up: "arrowup",
    Down: "arrowdown",
    Left: "arrowleft",
    Right: "arrowright",
    Space: " ",
    Enter: "enter",
    Tab: "tab",
    Escape: "escape",
  };
  const domKey = key.length === 1 ? key.toLowerCase() : namedKeys[key];
  if (!domKey) return null;
  return {
    key: domKey,
    metaKey: modifiers.has("Command"),
    ctrlKey: modifiers.has("Control"),
    altKey: modifiers.has("Option"),
    shiftKey: modifiers.has("Shift"),
  };
}

export function showHideShortcutConflict(accelerator: string | null): string | null {
  if (!accelerator) return null;
  const input = acceleratorToShortcutInput(accelerator);
  if (!input) return null;
  const command = resolveAppShortcut(input);
  return command ? appShortcutLabel(command) : null;
}

export function parseAppShortcutCommand(command: unknown): AppShortcutCommand | null {
  switch (command) {
    case "focusResearchHome":
    case "openSettings":
    case "openCommandPalette":
    case "toggleLeftSidebar":
    case "focusFollowups":
    case "openFolderMenu":
    case "toggleSourceBrowser":
      return { type: command };
    default:
      return null;
  }
}
