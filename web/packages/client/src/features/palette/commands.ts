// The ⌘K palette's contents (`07-client-architecture.md` §5, ported from
// `App.tsx:8098`).
//
// Two sections: every thread in the scoped workspace, and the handful of
// actions that are not a thread. The list is built only while the palette is
// open — a list rebuilt on every render of a closed dialog is work nobody sees
// — which is why this is a plain function the shell calls behind that flag
// rather than a hook that runs regardless.

import type { ResearchTreeSummary } from "@session/shared";

import type { PaletteCommand } from "../../ui/CommandPalette.js";

export interface PaletteActions {
  openTree: (treeId: string) => void;
  openHome: () => void;
  toggleSidebar: () => void;
  openSettings: () => void;
}

/** A thread's hint is what is happening in it, not what it is: a count of
 * admitted runs, or nothing. */
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
    { id: "home", section: "Actions", title: "Home", hint: "⇧⌘H", action: actions.openHome },
    {
      id: "toggle-sidebar",
      section: "Actions",
      title: "Toggle sidebar",
      hint: "⇧⌘G",
      action: actions.toggleSidebar,
    },
    {
      id: "settings",
      section: "Actions",
      title: "Settings",
      hint: "⌘,",
      action: actions.openSettings,
    },
  );
  return commands;
}
