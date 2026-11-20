// Where the open thread is in Home, for the thread page: the thread menu's
// Move to (`ThreadMenu`) and the Home group panel (`GroupPanel`), which the
// desktop's `App.tsx` builds from `useResearchFiling` as
// `ResearchThreadTreeMenu` and `ResearchThreadGroup`.
//
// Move to lists every place of the thread's workspace with the current one
// checked, then New folder…, which creates a folder and moves the thread into
// it. Moves go through Home's filing and group rules (`useFiling`,
// `useGroupActions`), so archiving a parent with children asks first, as from
// a feed card. The group panel lists, for a parent, the children listed under
// it in its Home place, and for a child, its parent; opening one of them from
// the panel expands the group in Home.
//
// Web only: both are for the reader's own thread. A member files a shared
// thread in their own folders from Home, where Shared with me is, and a
// shared thread's nesting is its owner's.

import type { ResearchFolder, ResearchTree, ResearchTreeSummary } from "@session/shared";
import { researchTreePlace } from "@session/shared/lib/researchFolders";
import { researchTreeGroups } from "@session/shared/lib/researchGroups";
import { researchThreadKind, researchThreadState } from "@session/shared/lib/researchRowGlyph";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, type ReactNode } from "react";

import { useResearchTrash } from "../../api/queries.js";
import { useFolderDialogStore } from "../home/FolderDialogsHost.js";
import { useFiling } from "../home/useFiling.js";
import { useGroupActions } from "../home/useGroupActions.js";
import { workspaceSearch } from "../sidebar/scope.js";

import type { ThreadGroup } from "./GroupPanel.js";

export interface ThreadTreeMenu {
  currentPlace: string;
  folders: ResearchFolder[];
  onMove: (place: string) => void;
  /** `trigger` is where focus returns when the folder dialog closes. */
  onNewFolder: (trigger: HTMLElement | null) => void;
}

export interface ThreadFiling {
  treeMenu: ThreadTreeMenu | undefined;
  group: ThreadGroup | null;
  /** Opens a thread of the group, expanding the group in Home. */
  openGroupTree: (treeId: string) => void;
  /** The archive confirmation for a parent with children, while it is open. */
  dialog: ReactNode;
}

const NO_TREES: ResearchTreeSummary[] = [];

/** The open thread's Home group, or null when it is in none. */
export function threadGroupFor(
  treeId: string,
  trees: readonly ResearchTreeSummary[],
  state: Parameters<typeof researchTreePlace>[1],
): ThreadGroup | null {
  const tree = trees.find((candidate) => candidate.id === treeId);
  if (!tree || tree.archivedAt != null) return null;
  const place = researchTreePlace(tree, state);
  const listed = trees.filter(
    (candidate) =>
      candidate.workspaceId === tree.workspaceId &&
      candidate.archivedAt == null &&
      researchTreePlace(candidate, state) === place,
  );
  const group = researchTreeGroups(listed, state.parents).find(
    (candidate) =>
      candidate.tree.id === tree.id || candidate.children.some((child) => child.id === tree.id),
  );
  if (!group || group.children.length === 0) return null;
  if (group.tree.id !== tree.id) {
    return { parent: { id: group.tree.id, title: group.tree.title }, children: [] };
  }
  return {
    parent: null,
    children: group.children.map((child) => ({
      id: child.id,
      title: child.title,
      kind: researchThreadKind(child, undefined),
      state: researchThreadState(child, undefined),
      unread: child.hasUnseenUpdate,
    })),
  };
}

export function useThreadFiling(
  tree: Pick<ResearchTree, "id" | "workspaceId" | "archivedAt"> | undefined,
  /** The reader owns the thread and it is not in the Trash. */
  enabled: boolean,
): ThreadFiling {
  const navigate = useNavigate();
  const workspaceId = enabled && tree ? tree.workspaceId : "";
  const filing = useFiling(workspaceId);
  const trash = useResearchTrash(workspaceId).data ?? NO_TREES;
  const groupActions = useGroupActions(filing, trash);
  const openNewFolder = useFolderDialogStore((state) => state.openNew);
  const treeId = tree?.id ?? null;
  const archivedAt = tree?.archivedAt ?? null;
  const { folderState, folders, trees, setGroupsCollapsed } = filing;
  // Moves read the thread from the workspace's list, so the menu waits for it.
  const listed = treeId !== null && trees.some((summary) => summary.id === treeId);
  const moveTree = groupActions.moveTree;

  const treeMenu = useMemo<ThreadTreeMenu | undefined>(() => {
    if (!enabled || treeId === null || !listed) return undefined;
    return {
      currentPlace: researchTreePlace({ id: treeId, archivedAt }, folderState),
      folders,
      onMove: (place) => moveTree(treeId, place),
      onNewFolder: (trigger) => openNewFolder(treeId, trigger, workspaceId),
    };
  }, [
    archivedAt,
    enabled,
    folderState,
    folders,
    listed,
    moveTree,
    openNewFolder,
    treeId,
    workspaceId,
  ]);

  // Kept as the same object while its contents are unchanged, so the columns
  // do not re-render for unrelated list updates.
  const groupKey = useMemo(
    () =>
      JSON.stringify(
        enabled && treeId !== null ? threadGroupFor(treeId, trees, folderState) : null,
      ),
    [enabled, folderState, treeId, trees],
  );
  const group = useMemo(() => JSON.parse(groupKey) as ThreadGroup | null, [groupKey]);

  const parents = folderState.parents;
  const openGroupTree = useCallback(
    (target: string) => {
      const parentId = parents[target];
      if (parentId) setGroupsCollapsed([parentId], false);
      void navigate({ to: "/r/$treeId", params: { treeId: target }, search: workspaceSearch });
    },
    [navigate, parents, setGroupsCollapsed],
  );

  return { treeMenu, group, openGroupTree, dialog: groupActions.dialog };
}
