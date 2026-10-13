// Default and displayed names of groups (research workspaces and terminal
// groups), derived from their directories.
import type { GroupInfo } from "../types";

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

/** The name a group shows without a name override: its directory's last
 * segment. */
export function defaultGroupName(group: GroupInfo, roots: GroupDirRoots): string {
  const dir = group.dir;
  const base = dir.split("/").filter(Boolean).pop();
  return base && base.length > 0 ? base : formatGroupDir(dir, roots);
}

export function displayGroupName(group: GroupInfo, roots: GroupDirRoots): string {
  return group.nameOverride?.trim() || defaultGroupName(group, roots);
}
