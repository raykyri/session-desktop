import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ResearchFolder, ResearchFolderState, ResearchTreeSummary } from "../types";
import {
  archiveResearchTree,
  listResearchFolders,
  reorderResearchTrees,
  restoreResearchTree,
  setResearchFolders,
} from "../lib/api";
import { createResearchFolderStore } from "../lib/researchFolderStore";
import {
  emptyResearchFolderState,
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchFolderStateRenamed,
  researchFolderStateWithCollapsed,
  researchFolderStateWithMembership,
  researchFolderStateWithNewFolder,
  researchFolderStateWithoutFolder,
  newResearchFolderId,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreeOrderAfterMove,
  researchTreePlace,
  workspaceResearchFolders,
} from "../lib/researchFolders";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const LOAD_RETRY_MS = [1000, 3000, 10000];

interface ResearchFilingOptions {
  workspaceId: string | null;
  /** Active trees in the backend's flat order, and archived trees. */
  activeTreesRef: RefObject<ResearchTreeSummary[]>;
  archivedTreesRef: RefObject<ResearchTreeSummary[]>;
  /** Applies a workspace's new flat order locally before the backend confirms it. */
  applyTreeOrder: (workspaceId: string, treeIds: string[]) => void;
  /** Re-reads trees after a rejected order or archive change. */
  refreshTrees: () => void;
  onError: (message: string) => void;
  showToast: (message: ReactNode, options?: { undo?: () => void }) => void;
}

/** Research folders (stored by the backend), tray collapse state, and moving
 * trees between Unfiled, Drafts, user folders, and Archive with undo. */
export function useResearchFiling({
  workspaceId,
  activeTreesRef,
  archivedTreesRef,
  applyTreeOrder,
  refreshTrees,
  onError,
  showToast,
}: ResearchFilingOptions) {
  const [folderState, setFolderState] = useState<ResearchFolderState>(emptyResearchFolderState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [store] = useState(() =>
    createResearchFolderStore({
      list: listResearchFolders,
      save: setResearchFolders,
      onState: setFolderState,
      onLoadError: setLoadError,
    }),
  );
  const optionsRef = useRef({ applyTreeOrder, refreshTrees, onError, showToast });
  optionsRef.current = { applyTreeOrder, refreshTrees, onError, showToast };

  // A failed load is retried on a timer, by every change, and by `retryLoad`.
  const { commit, refresh } = store;
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let attempt = 0;
    let timer = 0;
    let disposed = false;
    const tryLoad = () =>
      void store.load().catch(() => {
        if (disposed || attempt >= LOAD_RETRY_MS.length) return;
        timer = window.setTimeout(tryLoad, LOAD_RETRY_MS[attempt++]);
      });
    tryLoad();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [loadAttempt, store]);
  const retryLoad = useCallback(() => setLoadAttempt((value) => value + 1), []);

  const folders = useMemo(
    () => workspaceResearchFolders(folderState, workspaceId),
    [folderState, workspaceId],
  );

  const findTree = useCallback(
    (treeId: string) =>
      activeTreesRef.current?.find((tree) => tree.id === treeId) ??
      archivedTreesRef.current?.find((tree) => tree.id === treeId) ??
      null,
    [activeTreesRef, archivedTreesRef],
  );

  const workspaceOrder = useCallback(
    (treeWorkspaceId: string) =>
      (activeTreesRef.current ?? [])
        .filter((tree) => tree.workspaceId === treeWorkspaceId)
        .map((tree) => tree.id),
    [activeTreesRef],
  );

  const writeOrder = useCallback(
    async (treeWorkspaceId: string, order: string[]) => {
      optionsRef.current.applyTreeOrder(treeWorkspaceId, order);
      try {
        await reorderResearchTrees(treeWorkspaceId, false, order);
      } catch (err) {
        optionsRef.current.refreshTrees();
        throw err;
      }
    },
    [],
  );

  /** Files `treeId` in `place`, before `beforeId` when the place keeps an
   * order. A move to another place shows a toast with Undo; a reorder
   * within the same place shows none. With `newFolderName`, `place` is the
   * id of a folder created by the same write. A failure is reported, or
   * with `rejects` passed to the caller. */
  const moveTree = useCallback(
    async (
      treeId: string,
      place: string,
      beforeId: string | null = null,
      {
        toast = true,
        newFolderName = null,
        rejects = false,
      }: { toast?: boolean; newFolderName?: string | null; rejects?: boolean } = {},
    ) => {
      const tree = findTree(treeId);
      if (!tree) return;
      const state = store.getState();
      const from = researchTreePlace(tree, state);
      const reorderable = researchPlaceIsReorderable(place);
      if (from === place && (!beforeId || !reorderable)) return;
      const wasArchived = tree.archivedAt != null;
      const previousMember = state.membership[treeId] ?? null;
      const previousOrder = workspaceOrder(tree.workspaceId);
      try {
        if (place !== RESEARCH_ARCHIVE_FOLDER_ID) {
          await commit((current) =>
            researchFolderStateWithMembership(
              newFolderName
                ? researchFolderStateWithNewFolder(current, newFolderName, tree.workspaceId, place)
                    .state
                : current,
              treeId,
              place,
            ),
          );
        }
        if (place === RESEARCH_ARCHIVE_FOLDER_ID && !wasArchived) {
          await archiveResearchTree(treeId);
        } else if (place !== RESEARCH_ARCHIVE_FOLDER_ID && wasArchived) {
          await restoreResearchTree(treeId);
        }
        if (reorderable && (beforeId || from !== place)) {
          const flat = previousOrder.includes(treeId) ? previousOrder : [treeId, ...previousOrder];
          const members = (activeTreesRef.current ?? [])
            .filter(
              (candidate) =>
                candidate.workspaceId === tree.workspaceId &&
                researchTreePlace(candidate, store.getState()) === place,
            )
            .map((candidate) => candidate.id);
          const order = researchTreeOrderAfterMove(flat, members, treeId, beforeId);
          if (order.some((id, index) => id !== flat[index])) {
            await writeOrder(tree.workspaceId, order);
          }
        }
      } catch (err) {
        if (rejects) throw err;
        optionsRef.current.onError(errorMessage(err));
        return;
      }
      if (from === place || !toast) return;
      const name = researchPlaceName(place, store.getState().folders);
      const stillRunning =
        place === RESEARCH_ARCHIVE_FOLDER_ID && tree.runningCount > 0
          ? " It's still running; the answer will appear there."
          : "";
      optionsRef.current.showToast(
        createElement(
          "span",
          null,
          "Moved to ",
          createElement("b", null, name),
          `.${stillRunning}`,
        ),
        {
          undo: () => {
            void (async () => {
              try {
                await commit((current) =>
                  previousMember
                    ? researchFolderStateWithMembership(current, treeId, previousMember)
                    : researchFolderStateWithMembership(current, treeId, RESEARCH_UNFILED_FOLDER_ID),
                );
                if (wasArchived && place !== RESEARCH_ARCHIVE_FOLDER_ID) {
                  await archiveResearchTree(treeId);
                } else if (!wasArchived && place === RESEARCH_ARCHIVE_FOLDER_ID) {
                  await restoreResearchTree(treeId);
                }
                const current = workspaceOrder(tree.workspaceId);
                if (
                  !wasArchived &&
                  current.length === previousOrder.length &&
                  current.some((id, index) => id !== previousOrder[index])
                ) {
                  await writeOrder(tree.workspaceId, previousOrder);
                }
              } catch (err) {
                optionsRef.current.onError(errorMessage(err));
              }
            })();
          },
        },
      );
    },
    [activeTreesRef, commit, findTree, workspaceOrder, writeOrder],
  );

  /** Creates a folder in the scoped workspace. Rejects with the backend's
   * validation message, which the name dialog shows inline. */
  const createFolder = useCallback(
    async (name: string): Promise<ResearchFolder | null> => {
      if (!workspaceId) return null;
      let created: ResearchFolder | null = null;
      await commit((current) => {
        const result = researchFolderStateWithNewFolder(current, name, workspaceId);
        created = result.folder;
        return result.state;
      });
      return created;
    },
    [commit, workspaceId],
  );

  /** Creates a folder in the tree's workspace and moves the tree into it with
   * one write, so a failure leaves neither. Rejects with the reason, which
   * the name dialog shows inline. */
  const moveTreeToNewFolder = useCallback(
    (treeId: string, name: string) =>
      moveTree(treeId, newResearchFolderId(), null, { newFolderName: name, rejects: true }),
    [moveTree],
  );

  const renameFolder = useCallback(
    (folderId: string, name: string) =>
      commit((current) => researchFolderStateRenamed(current, folderId, name)),
    [commit],
  );

  /** Resolves true once the folder is deleted; a failure is reported. */
  const deleteFolder = useCallback(
    async (folderId: string): Promise<boolean> => {
      try {
        await commit((current) => researchFolderStateWithoutFolder(current, folderId));
        return true;
      } catch (err) {
        optionsRef.current.onError(errorMessage(err));
        return false;
      }
    },
    [commit],
  );

  const setTrayCollapsed = useCallback(
    (place: string, collapsed: boolean) => {
      void commit((current) => researchFolderStateWithCollapsed(current, place, collapsed)).catch(
        () => undefined,
      );
    },
    [commit],
  );

  /** Files a newly created tree without a toast (asking from a folder view). */
  const fileNewTree = useCallback(
    (treeId: string, place: string) => {
      void commit((current) => researchFolderStateWithMembership(current, treeId, place)).catch(
        (err: unknown) => optionsRef.current.onError(errorMessage(err)),
      );
    },
    [commit],
  );

  return {
    folderState,
    folders,
    moveTree,
    moveTreeToNewFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    setTrayCollapsed,
    fileNewTree,
    refreshFolders: refresh,
    foldersLoadError: loadError,
    retryFoldersLoad: retryLoad,
  };
}
