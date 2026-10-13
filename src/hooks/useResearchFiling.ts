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
  researchFolderStateWithFolderTrashed,
  researchFolderStateWithMembership,
  researchFolderStateWithNewFolder,
  researchFolderStateWithoutFolder,
  newResearchFolderId,
  researchDropBeforeId,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreeOrderAfterMove,
  researchTreePlace,
  workspaceResearchFolders,
  type ResearchDropPosition,
} from "../lib/researchFolders";
import {
  researchChildCount,
  researchChildIds,
  researchFolderStateWithGroupCollapsed,
  researchFolderStateWithParent,
  researchNestRefusal,
  researchOrderAfterMoveOut,
  researchOrderAfterNest,
  researchTreeGroups,
  researchTreeHoldsChildren,
} from "../lib/researchGroups";

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

  /** A workspace's trees listed in `place` (Archive: the archived ones), in
   * the flat order. */
  const placeTrees = useCallback(
    (treeWorkspaceId: string, place: string, state: ResearchFolderState) =>
      (
        (place === RESEARCH_ARCHIVE_FOLDER_ID ? archivedTreesRef.current : activeTreesRef.current) ?? []
      ).filter(
        (candidate) =>
          candidate.workspaceId === treeWorkspaceId && researchTreePlace(candidate, state) === place,
      ),
    [activeTreesRef, archivedTreesRef],
  );

  /** The top-level items of `place`, in order. */
  const topLevelIds = useCallback(
    (treeWorkspaceId: string, place: string, state: ResearchFolderState) =>
      researchTreeGroups(placeTrees(treeWorkspaceId, place, state), state.parents).map(
        (group) => group.tree.id,
      ),
    [placeTrees],
  );

  /** Files `treeId` in `place`. With `position` (a drop between cards, or a
   * keyboard move) it goes before `position.beforeId` among the place's
   * top-level items, or to the end for null, when the place keeps an order.
   * Without one, a tree filed in a folder or Drafts goes to its end, and one
   * moved to Unfiled keeps its slot in the tree order. A parent moves with
   * the children listed under it. A child filed in another place, or dropped
   * between top-level items, leaves its group; one moved to the Archive keeps
   * its link, so Unarchive lists it under its parent again. A move to another
   * place shows a toast with Undo; a reorder within the same place shows
   * none. With `newFolderName`, `place` is the id of a folder created by the
   * same write. A failure is reported, or with `rejects` passed to the
   * caller. */
  const moveTree = useCallback(
    async (
      treeId: string,
      place: string,
      position: ResearchDropPosition | null = null,
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
      if (from === place && (!position || !reorderable)) return;
      const parentId = state.parents[treeId] ?? null;
      const parent = parentId ? findTree(parentId) : null;
      // An archived child moved to its parent's place (Move to) rejoins the
      // group, as Unarchive does.
      const rejoins =
        from === RESEARCH_ARCHIVE_FOLDER_ID &&
        !position &&
        parent != null &&
        parent.archivedAt == null &&
        researchTreePlace(parent, state) === place;
      const leaves = parentId !== null && place !== RESEARCH_ARCHIVE_FOLDER_ID && !rejoins;
      const childIds = researchChildIds(
        treeId,
        placeTrees(tree.workspaceId, from, state),
        state.parents,
      );
      const members = [tree, ...childIds.flatMap((id) => findTree(id) ?? [])];
      const previousMembers = new Map(
        members.map((member) => [member.id, state.membership[member.id] ?? null]),
      );
      const wereArchived = new Set(
        members.filter((member) => member.archivedAt != null).map((member) => member.id),
      );
      const previousOrder = workspaceOrder(tree.workspaceId);
      try {
        if (place !== RESEARCH_ARCHIVE_FOLDER_ID) {
          await commit((current) => {
            let next = newFolderName
              ? researchFolderStateWithNewFolder(current, newFolderName, tree.workspaceId, place).state
              : current;
            if (leaves) next = researchFolderStateWithParent(next, treeId, null);
            for (const member of members) {
              next = researchFolderStateWithMembership(next, member.id, place);
            }
            return next;
          });
        }
        const archive = place === RESEARCH_ARCHIVE_FOLDER_ID;
        for (const member of members) {
          if (archive && !wereArchived.has(member.id)) await archiveResearchTree(member.id);
          else if (!archive && wereArchived.has(member.id)) await restoreResearchTree(member.id);
        }
        if (reorderable && (position || (from !== place && place !== RESEARCH_UNFILED_FOLDER_ID))) {
          const flat = previousOrder.includes(treeId) ? previousOrder : [treeId, ...previousOrder];
          const topLevel = topLevelIds(tree.workspaceId, place, store.getState());
          const order = researchTreeOrderAfterMove(
            flat,
            topLevel,
            treeId,
            position ? researchDropBeforeId(topLevel, treeId, position) : null,
          );
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
      const withChildren =
        childIds.length > 0 ? ` with its ${researchChildCount(childIds.length)}` : "";
      const stillRunning =
        place === RESEARCH_ARCHIVE_FOLDER_ID && members.some((member) => member.runningCount > 0)
          ? " It's still running; the answer will appear there."
          : "";
      optionsRef.current.showToast(
        createElement(
          "span",
          null,
          "Moved to ",
          createElement("b", null, name),
          `${withChildren}.${stillRunning}`,
        ),
        {
          undo: () => {
            void (async () => {
              try {
                await commit((current) => {
                  let next =
                    leaves && parentId
                      ? researchFolderStateWithParent(current, treeId, parentId)
                      : current;
                  for (const [id, member] of previousMembers) {
                    next = researchFolderStateWithMembership(
                      next,
                      id,
                      member ?? RESEARCH_UNFILED_FOLDER_ID,
                    );
                  }
                  return next;
                });
                for (const member of members) {
                  const archived = wereArchived.has(member.id);
                  if (archived && place !== RESEARCH_ARCHIVE_FOLDER_ID) {
                    await archiveResearchTree(member.id);
                  } else if (!archived && place === RESEARCH_ARCHIVE_FOLDER_ID) {
                    await restoreResearchTree(member.id);
                  }
                }
                const current = workspaceOrder(tree.workspaceId);
                if (
                  !wereArchived.has(treeId) &&
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
    [commit, findTree, placeTrees, topLevelIds, workspaceOrder, writeOrder],
  );

  /** Lists `treeId` under `parentId`, before `beforeId` (one of the parent's
   * children) or at the end of the group for null. The tree takes the
   * parent's folder, and an archived tree is unarchived. A tree with
   * children of its own is nested only with `flatten`: its children become
   * children of `parentId` after it. The group expands. A tree that changes
   * parent shows a toast with Undo. Resolves false when nothing changed. */
  const nestTree = useCallback(
    async (
      treeId: string,
      parentId: string,
      beforeId: string | null = null,
      { flatten = false }: { flatten?: boolean } = {},
    ): Promise<boolean> => {
      const tree = findTree(treeId);
      const parent = findTree(parentId);
      if (!tree || !parent || tree.workspaceId !== parent.workspaceId) return false;
      const state = store.getState();
      if (researchNestRefusal(treeId, parentId, state.parents) || state.parents[parentId]) {
        return false;
      }
      if (!researchTreeHoldsChildren(parent.type)) return false;
      const parentPlace = researchTreePlace(parent, state);
      if (parentPlace === RESEARCH_ARCHIVE_FOLDER_ID) return false;
      const from = researchTreePlace(tree, state);
      const ownChildIds = researchChildIds(
        treeId,
        placeTrees(tree.workspaceId, from, state),
        state.parents,
      );
      if (ownChildIds.length > 0 && !flatten) return false;
      const members = [tree, ...ownChildIds.flatMap((id) => findTree(id) ?? [])];
      const previous = new Map(
        members.map((member) => [
          member.id,
          {
            parent: state.parents[member.id] ?? null,
            member: state.membership[member.id] ?? null,
            archived: member.archivedAt != null,
          },
        ]),
      );
      const wasCollapsed = state.collapsedGroups.includes(parentId);
      const previousOrder = workspaceOrder(tree.workspaceId);
      const changesParent = state.parents[treeId] !== parentId;
      try {
        await commit((current) => {
          let next = researchFolderStateWithGroupCollapsed(current, parentId, false);
          for (const member of members) {
            next = researchFolderStateWithParent(next, member.id, parentId);
          }
          return next;
        });
        for (const member of members) {
          if (member.archivedAt != null) await restoreResearchTree(member.id);
        }
        const siblings = researchChildIds(
          parentId,
          placeTrees(parent.workspaceId, parentPlace, state),
          state.parents,
        ).filter((id) => !previous.has(id));
        let order = previousOrder;
        for (const member of members) {
          if (!order.includes(member.id)) order = [...order, member.id];
          order = researchOrderAfterNest(order, parentId, siblings, member.id, beforeId);
          if (beforeId === null) siblings.push(member.id);
        }
        if (
          order.length !== previousOrder.length ||
          order.some((id, index) => id !== previousOrder[index])
        ) {
          await writeOrder(tree.workspaceId, order);
        }
      } catch (err) {
        optionsRef.current.onError(errorMessage(err));
        return false;
      }
      if (!changesParent) return true;
      const withChildren =
        ownChildIds.length > 0 ? ` with its ${researchChildCount(ownChildIds.length)}` : "";
      optionsRef.current.showToast(
        createElement(
          "span",
          null,
          "Moved under ",
          createElement("b", null, parent.title),
          `${withChildren}.`,
        ),
        {
          undo: () => {
            void (async () => {
              try {
                await commit((current) => {
                  let next = researchFolderStateWithGroupCollapsed(current, parentId, wasCollapsed);
                  for (const [id, before] of previous) {
                    next = researchFolderStateWithParent(next, id, before.parent);
                    next = researchFolderStateWithMembership(
                      next,
                      id,
                      before.member ?? RESEARCH_UNFILED_FOLDER_ID,
                    );
                  }
                  return next;
                });
                for (const [id, before] of previous) {
                  if (before.archived) await archiveResearchTree(id);
                }
                const current = workspaceOrder(tree.workspaceId);
                if (
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
      return true;
    },
    [commit, findTree, placeTrees, workspaceOrder, writeOrder],
  );

  /** Move out: lists a child on its own, right after its former group.
   * Resolves false when the tree is not a child. */
  const moveOutOfGroup = useCallback(
    async (treeId: string): Promise<boolean> => {
      const tree = findTree(treeId);
      const state = store.getState();
      const parentId = state.parents[treeId];
      if (!tree || !parentId) return false;
      const place = researchTreePlace(tree, state);
      const topLevel = topLevelIds(tree.workspaceId, place, state);
      const siblings = researchChildIds(
        parentId,
        placeTrees(tree.workspaceId, place, state),
        state.parents,
      ).filter((id) => id !== treeId);
      const previousOrder = workspaceOrder(tree.workspaceId);
      try {
        await commit((current) => researchFolderStateWithParent(current, treeId, null));
        if (researchPlaceIsReorderable(place)) {
          const order = researchOrderAfterMoveOut(previousOrder, topLevel, parentId, treeId, siblings);
          if (order.some((id, index) => id !== previousOrder[index])) {
            await writeOrder(tree.workspaceId, order);
          }
        }
      } catch (err) {
        optionsRef.current.onError(errorMessage(err));
        return false;
      }
      return true;
    },
    [commit, findTree, placeTrees, topLevelIds, workspaceOrder, writeOrder],
  );

  /** Collapses or expands groups; the state is saved. */
  const setGroupsCollapsed = useCallback(
    (parentIds: readonly string[], collapsed: boolean) => {
      void commit((current) =>
        parentIds.reduce(
          (state, parentId) => researchFolderStateWithGroupCollapsed(state, parentId, collapsed),
          current,
        ),
      ).catch((err: unknown) => optionsRef.current.onError(errorMessage(err)));
    },
    [commit],
  );

  /** After a child was restored (from the Archive or the Trash) without its
   * parent: it rejoins the group, in its parent's folder, when the parent is
   * listed outside the Archive and the Trash; otherwise it leaves the group
   * and is listed on its own. */
  const settleRestoredChild = useCallback(
    async (treeId: string) => {
      const parentId = store.getState().parents[treeId];
      if (!parentId) return;
      const parent = activeTreesRef.current?.find((candidate) => candidate.id === parentId);
      const listed = parent !== undefined && parent.archivedAt == null;
      await commit((current) =>
        researchFolderStateWithParent(current, treeId, listed ? parentId : null),
      );
    },
    [activeTreesRef, commit],
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

  /** Moves a folder to the Trash, or with `trashed` false restores it.
   * Rejects with the reason (restoring fails while another folder has its
   * name). */
  const setFolderTrashed = useCallback(
    (folderId: string, trashed: boolean) =>
      commit((current) =>
        researchFolderStateWithFolderTrashed(current, folderId, trashed ? Date.now() : null),
      ),
    [commit],
  );

  /** Deletes folders in one write (emptying the Trash); rejects with the reason. */
  const deleteFolders = useCallback(
    (folderIds: readonly string[]) =>
      commit((current) =>
        folderIds.reduce((state, folderId) => researchFolderStateWithoutFolder(state, folderId), current),
      ),
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
    nestTree,
    moveOutOfGroup,
    setGroupsCollapsed,
    settleRestoredChild,
    moveTreeToNewFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    deleteFolders,
    setFolderTrashed,
    setTrayCollapsed,
    fileNewTree,
    refreshFolders: refresh,
    foldersLoadError: loadError,
    retryFoldersLoad: retryLoad,
  };
}
