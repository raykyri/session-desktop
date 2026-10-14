type LauncherTabAction = "capture" | "cycle-model" | "cycle-provider";

interface LauncherTabInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌃Tab cycles the model and ⌃⇧Tab the agent. Plain Tab is left alone so it
 * moves focus out of the composer like in any other field. */
export function launcherTabAction(
  event: LauncherTabInput,
  hasModelSelection: boolean,
): LauncherTabAction | null {
  if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  if (event.shiftKey) {
    return "cycle-provider";
  }
  return hasModelSelection ? "cycle-model" : "capture";
}
