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
import {
  emptyResearchFolderState,
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchFolderStateRenamed,
  researchFolderStateWithCollapsed,
  researchFolderStateWithMembership,
  researchFolderStateWithNewFolder,
  researchFolderStateWithoutFolder,
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
  const stateRef = useRef(folderState);
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const optionsRef = useRef({ applyTreeOrder, refreshTrees, onError, showToast });
  optionsRef.current = { applyTreeOrder, refreshTrees, onError, showToast };

  // Changes wait for the stored state to load, so a write never replaces
  // folders the frontend hasn't read. A failed load blocks writes (they
  // reject) and is retried, by the next change or on a timer.
  const loadRef = useRef<Promise<void> | null>(null);
  const commitSeqRef = useRef(0);
  const load = useCallback((): Promise<void> => {
    loadRef.current ??= listResearchFolders().then(
      (state) => {
        stateRef.current = state;
        setFolderState(state);
      },
      (err: unknown) => {
        loadRef.current = null;
        throw new Error(`Folders couldn't be loaded, so the change wasn't saved. ${errorMessage(err)}`);
      },
    );
    return loadRef.current;
  }, []);
  useEffect(() => {
    let attempt = 0;
    let timer = 0;
    let disposed = false;
    const tryLoad = () =>
      void load().catch(() => {
        if (disposed || attempt >= LOAD_RETRY_MS.length) return;
        timer = window.setTimeout(tryLoad, LOAD_RETRY_MS[attempt++]);
      });
    tryLoad();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [load]);

  /** Re-reads the stored state after another window (or a workspace removal)
   * changed it. Waits for this window's own writes; a change made meanwhile
   * wins over the fetched state. */
  const refresh = useCallback(async () => {
    const seq = commitSeqRef.current;
    await writeChainRef.current.catch(() => undefined);
    let state: ResearchFolderState;
    try {
      state = await listResearchFolders();
    } catch {
      return;
    }
    if (commitSeqRef.current !== seq) return;
    loadRef.current = Promise.resolve();
    stateRef.current = state;
    setFolderState(state);
  }, []);

  // Local first, then persisted in order; a rejected write restores the
  // state it replaced unless a later change already superseded it.
  const commit = useCallback(
    (update: (state: ResearchFolderState) => ResearchFolderState): Promise<void> =>
      load().then(() => {
        commitSeqRef.current += 1;
        const previous = stateRef.current;
        const next = update(previous);
        if (next === previous) return;
        stateRef.current = next;
        setFolderState(next);
        const write = writeChainRef.current
          .catch(() => undefined)
          .then(() => setResearchFolders(next))
          .then((saved) => {
            if (stateRef.current === next) {
              stateRef.current = saved;
              setFolderState(saved);
            }
          })
          .catch((err: unknown) => {
            if (stateRef.current === next) {
              stateRef.current = previous;
              setFolderState(previous);
            }
            throw err;
          });
        writeChainRef.current = write;
        return write;
      }),
    [load],
  );

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
   * within the same place shows none. */
  const moveTree = useCallback(
    async (
      treeId: string,
      place: string,
      beforeId: string | null = null,
      { toast = true }: { toast?: boolean } = {},
    ) => {
      const tree = findTree(treeId);
      if (!tree) return;
      const state = stateRef.current;
      const from = researchTreePlace(tree, state);
      const reorderable = researchPlaceIsReorderable(place);
      if (from === place && (!beforeId || !reorderable)) return;
      const wasArchived = tree.archivedAt != null;
      const previousMember = state.membership[treeId] ?? null;
      const previousOrder = workspaceOrder(tree.workspaceId);
      try {
        if (place !== RESEARCH_ARCHIVE_FOLDER_ID) {
          await commit((current) => researchFolderStateWithMembership(current, treeId, place));
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
                researchTreePlace(candidate, stateRef.current) === place,
            )
            .map((candidate) => candidate.id);
          const order = researchTreeOrderAfterMove(flat, members, treeId, beforeId);
          if (order.some((id, index) => id !== flat[index])) {
            await writeOrder(tree.workspaceId, order);
          }
        }
      } catch (err) {
        optionsRef.current.onError(errorMessage(err));
        return;
      }
      if (from === place || !toast) return;
      const name = researchPlaceName(place, stateRef.current.folders);
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
    createFolder,
    renameFolder,
    deleteFolder,
    setTrayCollapsed,
    fileNewTree,
    refreshFolders: refresh,
  };
}
