// The ⌘K palette's contents (`07-client-architecture.md` §5, ported from
// `App.tsx:8098`).
//
// The list contains workspace threads and global actions. It is built only
// while the palette is open to avoid unnecessary recalculation.

import type { ResearchTreeSummary } from "@session/shared";

import { formatChord } from "../../lib/platform.js";
import type { PaletteCommand } from "../../ui/CommandPalette.js";

export interface PaletteActions {
  openTree: (treeId: string) => void;
  openHome: () => void;
  toggleSidebar: () => void;
  openSettings: () => void;
}

/** The thread hint shows the number of active runs in progress, or nothing if idle. */
export function runningHint(tree: ResearchTreeSummary): string | undefined {
  return tree.runningCount > 0 ? `${tree.runningCount} running` : undefined;
}

export function buildPaletteCommands(
  trees: readonly ResearchTreeSummary[],
  actions: PaletteActions,
): PaletteCommand[] {
  const commands: PaletteCommand[] = trees.map((tree) => ({
    id: `tree:${tree.id}`,
    section: "Research",
    title: tree.title,
    ...(runningHint(tree) === undefined ? {} : { hint: runningHint(tree) }),
    action: () => actions.openTree(tree.id),
  }));
  commands.push(
    {
      id: "home",
      section: "Actions",
      title: "Home",
      hint: formatChord("mod+shift+h"),
      action: actions.openHome,
    },
    {
      id: "toggle-sidebar",
      section: "Actions",
      title: "Toggle sidebar",
      hint: formatChord("mod+shift+g"),
      action: actions.toggleSidebar,
    },
    {
      id: "settings",
      section: "Actions",
      title: "Settings",
      hint: formatChord("mod+,"),
      action: actions.openSettings,
    },
  );
  return commands;
}
