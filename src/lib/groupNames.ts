// Default and displayed names of groups (research workspaces and terminal
// groups), derived from their directories.
import type { GroupInfo, PaneInfo } from "../types";

/** The directories group directory labels are shown relative to. */
interface GroupDirRoots {
  workspaceRoot?: string | null;
  homeDir?: string | null;
}

// Compact directory label, the fallback name of a group whose directory has
// no last segment. Paths under the workspace root are shown relative to it
// (e.g. "group-1/agent-1"); home paths use ~/ and other paths fall back to
// their last two segments so the meaningful tail stays visible.
export function formatGroupDir(rawPath: string, roots: GroupDirRoots): string {
  const { workspaceRoot, homeDir } = roots;
  if (workspaceRoot && rawPath.startsWith(`${workspaceRoot}/`)) {
    const relative = rawPath.slice(workspaceRoot.length + 1);
    // When the workspace root is the home directory itself, the path is being
    // shown relative to home, so prefix it with ~/. Deeper roots already
    // produce relative paths and remain unchanged.
    return homeDir && workspaceRoot === homeDir ? `~/${relative}` : relative;
  }
  if (homeDir && rawPath === homeDir) {
    return "~";
  }
  if (homeDir && rawPath.startsWith(`${homeDir}/`)) {
    return `~/${rawPath.slice(homeDir.length + 1)}`;
  }
  const segments = rawPath.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return rawPath;
  }
  return `…/${segments.slice(-2).join("/")}`;
}

// The directory a group's default title reflects: its root terminal (the first,
// oldest shell pane in the group), falling back to the group's creation-time seed
// dir when the group has no shell pane yet (empty, or agent-only — whose worktree
// dirs shouldn't name the group). Groups are advisory, so the title tracks where
// the group's work is rooted rather than a fixed stored directory, and is stable
// against focus changes. Reactive: a cd in the root terminal patches panes[].cwd
// (pane.cwd_changed), and closing it promotes the next shell — both re-derive here.
function groupRootDir(group: GroupInfo, panes: readonly PaneInfo[]): string {
  const rootShell = panes.find((pane) => pane.groupId === group.id && pane.kind === "shell");
  return rootShell?.cwd || group.dir;
}

/** The name a group shows without a name override: its root directory's last
 * segment. */
export function defaultGroupName(
  group: GroupInfo,
  panes: readonly PaneInfo[],
  roots: GroupDirRoots,
): string {
  const dir = groupRootDir(group, panes);
  const base = dir.split("/").filter(Boolean).pop();
  return base && base.length > 0 ? base : formatGroupDir(dir, roots);
}

export function displayGroupName(
  group: GroupInfo,
  panes: readonly PaneInfo[],
  roots: GroupDirRoots,
): string {
  return group.nameOverride?.trim() || defaultGroupName(group, panes, roots);
}
