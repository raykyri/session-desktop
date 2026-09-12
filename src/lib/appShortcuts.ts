export type AppShortcutCommand =
  | { type: "focusResearchTab"; tabIndex: number }
  | { type: "openNewResearch" }
  | { type: "cycleResearchTab"; direction: -1 | 1 }
  | { type: "moveResearchItem"; direction: -1 | 1 }
  | { type: "openSettings" }
  | { type: "openCommandPalette" }
  | { type: "toggleLeftSidebar" }
  | { type: "newDocument" }
  | { type: "focusFollowups" }
  | { type: "openFolderMenu" }
  | { type: "toggleSourceBrowser" };

export interface AppShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  terminalTarget?: boolean;
  editableTarget?: boolean;
}

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
    return { type: "openNewResearch" };
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
  if (command && !control && !option && !shift && key === "d") {
    return { type: "newDocument" };
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
    case "focusResearchTab":
      return `focus research item ${command.tabIndex + 1}`;
    case "openNewResearch":
      return "start new research";
    case "cycleResearchTab":
      return "cycle research items";
    case "moveResearchItem":
      return "move the active research item";
    case "openSettings":
      return "open settings";
    case "openCommandPalette":
      return "open the command palette";
    case "toggleLeftSidebar":
      return "toggle the sidebar";
    case "newDocument":
      return "create a document";
    case "focusFollowups":
      return "jump to the follow-ups";
    case "openFolderMenu":
      return "open the research folder menu";
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
    editableTarget: false,
  };
}

export function showHideShortcutConflict(accelerator: string | null): string | null {
  if (!accelerator) return null;
  const input = acceleratorToShortcutInput(accelerator);
  if (!input) return null;
  const command = resolveAppShortcut(input);
  return command ? appShortcutLabel(command) : null;
}

export function appShortcutAllowsRepeat(command: AppShortcutCommand): boolean {
  return command.type === "moveResearchItem";
}

export function parseAppShortcutCommand(
  command: unknown,
  tabIndex: unknown,
): AppShortcutCommand | null {
  switch (command) {
    case "openNewResearch":
    case "openSettings":
    case "openCommandPalette":
    case "toggleLeftSidebar":
    case "newDocument":
    case "focusFollowups":
    case "openFolderMenu":
    case "toggleSourceBrowser":
      return { type: command };
    case "focusResearchTab":
      return typeof tabIndex === "number" && Number.isInteger(tabIndex) && tabIndex >= 0
        ? { type: "focusResearchTab", tabIndex }
        : null;
    case "cyclePaneTabPrevious":
    case "cycleResearchTabPrevious":
      return { type: "cycleResearchTab", direction: -1 };
    case "cyclePaneTabNext":
    case "cycleResearchTabNext":
      return { type: "cycleResearchTab", direction: 1 };
    case "moveSidebarItemUp":
    case "moveResearchItemUp":
      return { type: "moveResearchItem", direction: -1 };
    case "moveSidebarItemDown":
    case "moveResearchItemDown":
      return { type: "moveResearchItem", direction: 1 };
    default:
      return null;
  }
}
