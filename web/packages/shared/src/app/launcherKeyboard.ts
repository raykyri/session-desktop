// Tab inside a launcher composer. The web has one flat model registry
// (`04-agent-runtime.md` §1), so Tab has a single meaning: step to the next
// model when the launcher offers a model selection, otherwise let the launcher
// keep the key (the desktop's provider cycle had a second dimension to cycle
// and is gone with the adapters).

export type LauncherTabAction = "capture" | "cycle-model";

interface LauncherTabInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function launcherTabAction(
  event: LauncherTabInput,
  hasModelSelection: boolean,
): LauncherTabAction | null {
  if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  return hasModelSelection ? "cycle-model" : "capture";
}
