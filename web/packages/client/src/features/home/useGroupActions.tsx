// What happens to a parent's children when the parent is archived, moved to
// the Trash, deleted or restored (the desktop's `useResearchGroupActions`):
// they go with it. Archiving a parent with children, and nesting a parent
// with children under another parent (which flattens the two levels into
// one), ask first.
//
// The server moves the children with their parent (`research.archiveTree`,
// `trashTree`, `restoreTreeFromTrash`, `removeTree`), so each action is one
// call for the parent; the children listed here are what the confirmations
// and toasts count.

import type { ResearchTreeSummary } from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  researchTreePlace,
  type ResearchDropPosition,
} from "@session/shared/lib/researchFolders";
import { researchChildCount } from "@session/shared/lib/researchGroups";
import { useCallback, useState, type ReactNode } from "react";

import {
  useRemoveResearchTree,
  useRestoreResearchTreeFromTrash,
  useTrashResearchTree,
  useArchiveResearchTree,
} from "../../api/queries.js";
import { pushErrorToast, pushToast } from "../../lib/toast.js";
import { DeleteDialog } from "../../ui/DeleteDialog.js";

import { ownTree, type Filing } from "./useFiling.js";

type PendingGroupAction =
  | { kind: "archive"; tree: ResearchTreeSummary; children: ResearchTreeSummary[] }
  | {
      kind: "flatten";
      tree: ResearchTreeSummary;
      parent: ResearchTreeSummary;
      children: ResearchTreeSummary[];
      beforeId: string | null;
    };

export interface GroupActions {
  /** The children that go with `treeId`: those listed under it (active), or
   * for a tree in the Archive or the Trash, its children there. */
  groupChildren: (treeId: string) => ResearchTreeSummary[];
  /** Files a tree; archiving a parent with children asks first. */
  moveTree: (treeId: string, place: string, position?: ResearchDropPosition | null) => void;
  /** Lists a tree under a parent; a tree with children of its own asks
   * first, since its children become the parent's children too. */
  nestTree: (treeId: string, parentId: string, beforeId?: string | null) => void;
  /** Moves a tree and its children to the Trash, with Undo in the toast.
   * Rejects when the tree can't be moved. */
  trashGroup: (treeId: string) => Promise<void>;
  /** Deletes a tree and its children now. Rejects with the reason. */
  removeGroup: (treeId: string) => Promise<void>;
  unarchiveGroup: (treeId: string) => Promise<void>;
  restoreGroupFromTrash: (treeId: string) => Promise<void>;
  /** The confirmation of an archive or a flatten, while one is pending. */
  dialog: ReactNode;
}

export function useGroupActions(
  filing: Filing,
  trashedTrees: readonly ResearchTreeSummary[],
): GroupActions {
  const trash = useTrashResearchTree();
  const restoreFromTrash = useRestoreResearchTreeFromTrash();
  const remove = useRemoveResearchTree();
  const archive = useArchiveResearchTree();
  const [pending, setPending] = useState<PendingGroupAction | null>(null);
  const { folderState, findTree: findListed, trees } = filing;

  const findTree = useCallback(
    (treeId: string) =>
      findListed(treeId) ?? trashedTrees.find((tree) => tree.id === treeId) ?? null,
    [findListed, trashedTrees],
  );

  const groupChildren = useCallback(
    (treeId: string): ResearchTreeSummary[] => {
      const tree = findTree(treeId);
      if (!tree || folderState.parents[treeId]) return [];
      const isChild = (candidate: ResearchTreeSummary) =>
        candidate.id !== treeId &&
        candidate.workspaceId === tree.workspaceId &&
        folderState.parents[candidate.id] === treeId;
      if (tree.trashedAt != null) return trashedTrees.filter(isChild);
      if (tree.archivedAt != null) {
        return trees.filter((candidate) => candidate.archivedAt != null && isChild(candidate));
      }
      const place = researchTreePlace(tree, folderState);
      return trees.filter(
        (candidate) =>
          candidate.archivedAt == null &&
          isChild(candidate) &&
          researchTreePlace(candidate, folderState) === place,
      );
    },
    [findTree, folderState, trashedTrees, trees],
  );

  const moveTree = useCallback(
    (treeId: string, place: string, position: ResearchDropPosition | null = null) => {
      const tree = findTree(treeId);
      const children = groupChildren(treeId);
      if (
        tree &&
        place === RESEARCH_ARCHIVE_FOLDER_ID &&
        tree.archivedAt == null &&
        children.length > 0
      ) {
        setPending({ kind: "archive", tree, children });
        return;
      }
      void filing.moveTree(treeId, place, position);
    },
    [filing, findTree, groupChildren],
  );

  const nestTree = useCallback(
    (treeId: string, parentId: string, beforeId: string | null = null) => {
      const tree = findTree(treeId);
      const parent = findTree(parentId);
      const children = groupChildren(treeId);
      if (tree && parent && children.length > 0) {
        setPending({ kind: "flatten", tree, parent, children, beforeId });
        return;
      }
      void filing.nestTree(treeId, parentId, beforeId);
    },
    [filing, findTree, groupChildren],
  );

  const trashGroup = useCallback(
    async (treeId: string) => {
      const children = groupChildren(treeId);
      // A member's Trash entry for a shared thread belongs to the workspace
      // it was trashed from.
      const tree = findTree(treeId);
      const shared = tree !== null && !ownTree(tree);
      await trash.mutateAsync({
        treeId,
        workspaceId: shared ? filing.workspaceId || undefined : undefined,
      });
      const withChildren =
        children.length > 0 ? ` with its ${researchChildCount(children.length)}` : "";
      pushToast({
        title: `Moved to the Trash${withChildren}.`,
        undo: () =>
          void restoreFromTrash
            .mutateAsync(treeId)
            .catch((failure: unknown) => pushErrorToast("Couldn’t restore", failure)),
      });
    },
    [filing.workspaceId, findTree, groupChildren, restoreFromTrash, trash],
  );

  const removeGroup = useCallback(
    async (treeId: string) => {
      await remove.mutateAsync(treeId);
    },
    [remove],
  );

  /** A child restored without its parent rejoins its group when the parent
   * is listed, else it is listed on its own. */
  const settle = useCallback(
    async (treeId: string) => {
      if (folderState.parents[treeId]) await filing.settleRestoredChild(treeId);
    },
    [filing, folderState.parents],
  );

  const unarchiveGroup = useCallback(
    async (treeId: string) => {
      try {
        await archive.mutateAsync({ treeId, archived: false });
        await settle(treeId);
      } catch (failure) {
        pushErrorToast("Couldn’t unarchive", failure);
      }
    },
    [archive, settle],
  );

  const restoreGroupFromTrash = useCallback(
    async (treeId: string) => {
      await restoreFromTrash.mutateAsync(treeId);
      await settle(treeId);
    },
    [restoreFromTrash, settle],
  );

  const close = () => setPending(null);
  let dialog: ReactNode = null;
  if (pending?.kind === "archive") {
    const { tree, children } = pending;
    const count = researchChildCount(children.length);
    dialog = (
      <DeleteDialog
        remove={{
          title: `Archive “${tree.title}” and its ${count}?`,
          body: (
            <p className="m-0">
              They move to the Archive together. Unarchiving “{tree.title}” brings{" "}
              {children.length === 1 ? "its child" : "its children"} back with it.
            </p>
          ),
          label: "Archive",
          pendingLabel: "Archiving…",
          tone: "primary",
          onConfirm: () =>
            filing.moveTree(tree.id, RESEARCH_ARCHIVE_FOLDER_ID, null, { rejects: true }),
        }}
        onClose={close}
      />
    );
  } else if (pending?.kind === "flatten") {
    const { tree, parent, children, beforeId } = pending;
    const count = researchChildCount(children.length);
    dialog = (
      <DeleteDialog
        remove={{
          title: `Move “${tree.title}” and its ${count} under “${parent.title}”?`,
          body: (
            <p className="m-0">
              Nesting is one level deep, so “{tree.title}” and its {count} all become children of “
              {parent.title}”, and “{tree.title}” no longer has children of its own.
            </p>
          ),
          label: "Move",
          pendingLabel: "Moving…",
          tone: "primary",
          onConfirm: async () => {
            await filing.nestTree(tree.id, parent.id, beforeId, { flatten: true });
          },
        }}
        onClose={close}
      />
    );
  }

  return {
    groupChildren,
    moveTree,
    nestTree,
    trashGroup,
    removeGroup,
    unarchiveGroup,
    restoreGroupFromTrash,
    dialog,
  };
}
