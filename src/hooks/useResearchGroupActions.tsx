import { useCallback, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ResearchFolderState, ResearchTreeSummary } from "../types";
import { restoreResearchTree, restoreResearchTreeFromTrash } from "../lib/api";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  researchTreePlace,
  type ResearchDropPosition,
} from "../lib/researchFolders";
import { researchChildCount } from "../lib/researchGroups";
import { ResearchDeleteDialog } from "../components/research/ResearchDeleteDialog";
import { researchFeedCardControl } from "../components/research/ResearchFeedCard";
import type { useResearchFiling } from "./useResearchFiling";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ResearchGroupActionsOptions {
  filing: Pick<
    ReturnType<typeof useResearchFiling>,
    "folderState" | "moveTree" | "nestTree" | "settleRestoredChild"
  >;
  activeTreesRef: RefObject<ResearchTreeSummary[]>;
  archivedTreesRef: RefObject<ResearchTreeSummary[]>;
  /** The trees in the Trash (every workspace). */
  trashedTrees: ResearchTreeSummary[];
  /** Moves one thread to the Trash and closes it when it is open. */
  trashTree: (treeId: string) => Promise<void>;
  /** Deletes one thread permanently; rejects with the reason. */
  removeTree: (treeId: string) => Promise<void>;
  onError: (message: string) => void;
  showToast: (message: ReactNode, options?: { undo?: () => void }) => void;
}

type PendingGroupAction =
  | { kind: "archive"; tree: ResearchTreeSummary; children: ResearchTreeSummary[] }
  | {
      kind: "flatten";
      tree: ResearchTreeSummary;
      parent: ResearchTreeSummary;
      children: ResearchTreeSummary[];
      beforeId: string | null;
    };

/** What happens to a parent's children when the parent is archived, moved
 * to the Trash, deleted or restored: they go with it. Archiving a parent
 * with children, and nesting a parent with children under another parent
 * (which flattens the two levels into one), ask first. */
export function useResearchGroupActions({
  filing,
  activeTreesRef,
  archivedTreesRef,
  trashedTrees,
  trashTree,
  removeTree,
  onError,
  showToast,
}: ResearchGroupActionsOptions) {
  const folderStateRef = useRef<ResearchFolderState>(filing.folderState);
  folderStateRef.current = filing.folderState;
  const trashedTreesRef = useRef(trashedTrees);
  trashedTreesRef.current = trashedTrees;
  const optionsRef = useRef({ filing, trashTree, removeTree, onError, showToast });
  optionsRef.current = { filing, trashTree, removeTree, onError, showToast };
  const [pending, setPending] = useState<PendingGroupAction | null>(null);

  const findTree = useCallback(
    (treeId: string) =>
      activeTreesRef.current?.find((tree) => tree.id === treeId) ??
      archivedTreesRef.current?.find((tree) => tree.id === treeId) ??
      trashedTreesRef.current.find((tree) => tree.id === treeId) ??
      null,
    [activeTreesRef, archivedTreesRef],
  );

  /** The children that go with `treeId`: those listed under it (active),
   * or for a tree in the Archive or the Trash, its children there. */
  const groupChildren = useCallback(
    (treeId: string): ResearchTreeSummary[] => {
      const tree = findTree(treeId);
      const state = folderStateRef.current;
      if (!tree || state.parents[treeId]) return [];
      const isChild = (candidate: ResearchTreeSummary) =>
        candidate.id !== treeId &&
        candidate.workspaceId === tree.workspaceId &&
        state.parents[candidate.id] === treeId;
      if (tree.trashedAt != null) return trashedTreesRef.current.filter(isChild);
      if (tree.archivedAt != null) return (archivedTreesRef.current ?? []).filter(isChild);
      const place = researchTreePlace(tree, state);
      return (activeTreesRef.current ?? []).filter(
        (candidate) => isChild(candidate) && researchTreePlace(candidate, state) === place,
      );
    },
    [activeTreesRef, archivedTreesRef, findTree],
  );

  /** Files a tree; archiving a parent with children asks first. */
  const moveTree = useCallback(
    (treeId: string, place: string, position: ResearchDropPosition | null = null) => {
      const tree = findTree(treeId);
      const children = groupChildren(treeId);
      if (tree && place === RESEARCH_ARCHIVE_FOLDER_ID && tree.archivedAt == null && children.length > 0) {
        setPending({ kind: "archive", tree, children });
        return;
      }
      void optionsRef.current.filing.moveTree(treeId, place, position);
    },
    [findTree, groupChildren],
  );

  /** Lists a tree under a parent; a tree with children of its own asks
   * first, since its children become the parent's children too. */
  const nestTree = useCallback(
    (treeId: string, parentId: string, beforeId: string | null = null) => {
      const tree = findTree(treeId);
      const parent = findTree(parentId);
      const children = groupChildren(treeId);
      if (tree && parent && children.length > 0) {
        setPending({ kind: "flatten", tree, parent, children, beforeId });
        return;
      }
      void optionsRef.current.filing.nestTree(treeId, parentId, beforeId);
    },
    [findTree, groupChildren],
  );

  /** Moves a thread and its children to the Trash, with Undo in the toast.
   * Rejects when the thread itself can't be moved. */
  const trashGroup = useCallback(
    async (treeId: string) => {
      const children = groupChildren(treeId);
      const { trashTree: trash } = optionsRef.current;
      await trash(treeId);
      const moved = [treeId];
      try {
        for (const child of children) {
          await trash(child.id);
          moved.push(child.id);
        }
      } catch (err) {
        optionsRef.current.onError(errorMessage(err));
      }
      const withChildren =
        moved.length > 1 ? ` with its ${researchChildCount(moved.length - 1)}` : "";
      optionsRef.current.showToast(`Moved to the Trash${withChildren}.`, {
        undo: () =>
          void (async () => {
            try {
              for (const id of moved) await restoreResearchTreeFromTrash(id);
            } catch (err) {
              optionsRef.current.onError(errorMessage(err));
            }
          })(),
      });
    },
    [groupChildren],
  );

  /** Deletes a thread and its children permanently: the children first, so
   * a failure leaves the parent and the rest of its group. Rejects with the
   * reason. */
  const removeGroup = useCallback(
    async (treeId: string) => {
      const children = groupChildren(treeId);
      for (const child of children) await optionsRef.current.removeTree(child.id);
      await optionsRef.current.removeTree(treeId);
    },
    [groupChildren],
  );

  /** Restores a tree and its children from `restore`'s place (the Archive
   * or the Trash). A child restored without its parent rejoins its group
   * when the parent is listed, else it is listed on its own. */
  const restoreWith = useCallback(
    async (treeId: string, restore: (id: string) => Promise<unknown>) => {
      const children = groupChildren(treeId);
      await restore(treeId);
      for (const child of children) await restore(child.id);
      if (folderStateRef.current.parents[treeId]) {
        await optionsRef.current.filing.settleRestoredChild(treeId);
      }
    },
    [groupChildren],
  );

  /** Unarchive: the tree, and its children in the Archive. */
  const unarchiveGroup = useCallback(
    async (treeId: string) => {
      try {
        await restoreWith(treeId, restoreResearchTree);
      } catch (err) {
        optionsRef.current.onError(errorMessage(err));
      }
    },
    [restoreWith],
  );

  /** Restore from the Trash: the tree, and its children in the Trash.
   * Rejects with the reason. */
  const restoreGroupFromTrash = useCallback(
    (treeId: string) => restoreWith(treeId, restoreResearchTreeFromTrash),
    [restoreWith],
  );

  const close = () => setPending(null);
  const focusCard = (treeId: string) => () => researchFeedCardControl(treeId);
  let dialog: ReactNode = null;
  if (pending?.kind === "archive") {
    const { tree, children } = pending;
    const count = researchChildCount(children.length);
    dialog = (
      <ResearchDeleteDialog
        fallbackFocus={focusCard(tree.id)}
        remove={{
          title: `Archive “${tree.title}” and its ${count}?`,
          body: (
            <p>
              They move to the Archive together. Unarchiving “{tree.title}” brings{" "}
              {children.length === 1 ? "its child" : "its children"} back with it.
            </p>
          ),
          label: "Archive",
          pendingLabel: "Archiving…",
          tone: "primary",
          onConfirm: () =>
            optionsRef.current.filing.moveTree(tree.id, RESEARCH_ARCHIVE_FOLDER_ID, null, {
              rejects: true,
            }),
        }}
        onClose={close}
      />
    );
  } else if (pending?.kind === "flatten") {
    const { tree, parent, children, beforeId } = pending;
    const count = researchChildCount(children.length);
    dialog = (
      <ResearchDeleteDialog
        fallbackFocus={focusCard(tree.id)}
        remove={{
          title: `Move “${tree.title}” and its ${count} under “${parent.title}”?`,
          body: (
            <p>
              Nesting is one level deep, so “{tree.title}” and its {count} all become children of “
              {parent.title}”, and “{tree.title}” no longer has children of its own.
            </p>
          ),
          label: "Move",
          pendingLabel: "Moving…",
          tone: "primary",
          onConfirm: async () => {
            await optionsRef.current.filing.nestTree(tree.id, parent.id, beforeId, { flatten: true });
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
