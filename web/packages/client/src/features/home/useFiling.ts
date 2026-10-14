// Filing for one workspace (the desktop's `useResearchFiling.ts`): its folder
// state, the trays' collapsed state, and moving threads between Unfiled,
// Drafts, folders and the Archive, nesting them under a parent and moving
// them out again, each with Undo.
//
// The folder state is the `["folders", workspaceId]` query: a change is
// written to it at once and saved with `folders.set`, in order, and a
// rejected save restores the state it replaced unless a later change
// superseded it (the desktop's `researchFolderStore`). The flat thread order
// is the `["trees", …]` lists, saved with `research.reorderTrees`.
//
// The server applies the group rules (`research.archiveTree`,
// `restoreTree`, … take the children listed under a parent), so the parent
// alone is archived or unarchived here, where the desktop called once per
// member.

import type { ResearchFolder, ResearchFolderState, ResearchTreeSummary } from "@session/shared";
import {
  emptyResearchFolderState,
  newResearchFolderId,
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchDropBeforeId,
  researchFolderStateRenamed,
  researchFolderStateWithCollapsed,
  researchFolderStateWithFolderTrashed,
  researchFolderStateWithMembership,
  researchFolderStateWithNewFolder,
  researchFolderStateWithoutFolder,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreeOrderAfterMove,
  researchTreePlace,
  workspaceResearchFolders,
  type ResearchDropPosition,
} from "@session/shared/lib/researchFolders";
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
} from "@session/shared/lib/researchGroups";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  archiveResearchTree,
  listResearchFolders,
  reorderResearchTrees,
  restoreResearchTree,
  setResearchFolders,
} from "../../api/api.js";
import { eachTreeList, invalidateKeys, queryKeys } from "../../api/cache.js";
import { useFolders, useTreeSummaries } from "../../api/queries.js";
import { errorMessage, pushErrorToast, pushToast } from "../../lib/toast.js";

const EMPTY_FOLDER_STATE: ResearchFolderState = emptyResearchFolderState();
const EMPTY_TREES: ResearchTreeSummary[] = [];

/* -------------------------------------------------------------------------
 * The folder state's writes, per workspace
 * ---------------------------------------------------------------------- */

interface FolderWrites {
  chain: Promise<unknown>;
  /** Bumped by every change, so a save's result is applied only when no
   * later change superseded it. */
  seq: number;
}

const folderWrites = new WeakMap<QueryClient, Map<string, FolderWrites>>();

function writesFor(client: QueryClient, workspaceId: string): FolderWrites {
  let byWorkspace = folderWrites.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    folderWrites.set(client, byWorkspace);
  }
  let writes = byWorkspace.get(workspaceId);
  if (!writes) {
    writes = { chain: Promise.resolve(), seq: 0 };
    byWorkspace.set(workspaceId, writes);
  }
  return writes;
}

/** Applies `update` to the workspace's folder state now and saves it.
 * Changes wait for the stored state to load, so a write never replaces
 * folders the client hasn't read. Rejects with the server's message (a
 * folder-name refusal, a stale state), after restoring the state it replaced
 * unless a later change superseded it. */
export async function commitFolderState(
  client: QueryClient,
  workspaceId: string,
  update: (current: ResearchFolderState) => ResearchFolderState,
): Promise<void> {
  const key = queryKeys.folders(workspaceId);
  const loaded = client.getQueryData<ResearchFolderState>(key);
  let previous: ResearchFolderState;
  if (loaded === undefined) {
    try {
      previous = await client.fetchQuery({
        queryKey: key,
        queryFn: () => listResearchFolders(workspaceId),
      });
    } catch (failure) {
      throw new Error(
        `Folders couldn't be loaded, so the change wasn't saved. ${errorMessage(failure)}`,
      );
    }
  } else {
    previous = loaded;
  }
  const next = update(previous);
  if (next === previous) return;
  const writes = writesFor(client, workspaceId);
  writes.seq += 1;
  const seq = writes.seq;
  // A refetch in flight would overwrite the change with the state before it.
  void client.cancelQueries({ queryKey: key });
  client.setQueryData(key, next);
  const write = writes.chain
    .then(() => setResearchFolders(workspaceId, next))
    .then((saved) => {
      if (writes.seq === seq) client.setQueryData(key, saved);
    })
    .catch((failure: unknown) => {
      if (writes.seq === seq) client.setQueryData(key, previous);
      throw failure;
    });
  writes.chain = write.catch(() => undefined);
  return write;
}

/* -------------------------------------------------------------------------
 * The flat thread order
 * ---------------------------------------------------------------------- */

/** Puts the active (unarchived) threads of a list in `order`, in the slots
 * they already hold. A list that does not hold exactly those threads is left
 * as it is. */
function withActiveOrder(
  summaries: ResearchTreeSummary[],
  workspaceId: string,
  order: readonly string[],
): ResearchTreeSummary[] {
  const isActive = (tree: ResearchTreeSummary) =>
    tree.workspaceId === workspaceId && tree.archivedAt == null;
  const active = summaries.filter(isActive);
  if (active.length !== order.length) return summaries;
  const byId = new Map(active.map((tree) => [tree.id, tree]));
  const queue = order.flatMap((id) => byId.get(id) ?? []);
  if (queue.length !== active.length) return summaries;
  let index = 0;
  return summaries.map((tree) => (isActive(tree) ? (queue[index++] ?? tree) : tree));
}

/** Rejects a place's archived-ness: the Archive has its own order. */
function activeOrder(trees: readonly ResearchTreeSummary[]): string[] {
  return trees.filter((tree) => tree.archivedAt == null).map((tree) => tree.id);
}

/* -------------------------------------------------------------------------
 * The hook
 * ---------------------------------------------------------------------- */

export interface Filing {
  workspaceId: string;
  folderState: ResearchFolderState;
  /** The workspace's folders outside the Trash. */
  folders: ResearchFolder[];
  /** Active threads in the flat order, then archived ones. */
  trees: ResearchTreeSummary[];
  foldersLoadError: string | null;
  retryFoldersLoad: () => void;
  findTree: (treeId: string) => ResearchTreeSummary | null;
  moveTree: (
    treeId: string,
    place: string,
    position?: ResearchDropPosition | null,
    options?: { toast?: boolean; newFolderName?: string | null; rejects?: boolean },
  ) => Promise<void>;
  nestTree: (
    treeId: string,
    parentId: string,
    beforeId?: string | null,
    options?: { flatten?: boolean },
  ) => Promise<boolean>;
  moveOutOfGroup: (treeId: string) => Promise<boolean>;
  setGroupsCollapsed: (parentIds: readonly string[], collapsed: boolean) => void;
  settleRestoredChild: (treeId: string) => Promise<void>;
  createFolder: (name: string) => Promise<ResearchFolder | null>;
  moveTreeToNewFolder: (treeId: string, name: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<boolean>;
  setFolderTrashed: (folderId: string, trashed: boolean) => Promise<void>;
  setTrayCollapsed: (place: string, collapsed: boolean) => void;
  fileNewTree: (treeId: string, place: string) => void;
}

export function useFiling(workspaceId: string): Filing {
  const client = useQueryClient();
  const folderQuery = useFolders(workspaceId);
  const treeQuery = useTreeSummaries({ workspaceId, includeArchived: true });
  const folderState = folderQuery.data ?? EMPTY_FOLDER_STATE;
  const trees = treeQuery.data ?? EMPTY_TREES;
  const folders = useMemo(
    () => workspaceResearchFolders(folderState, workspaceId),
    [folderState, workspaceId],
  );

  const listKey = queryKeys.trees({ workspaceId, includeArchived: true });
  const currentTrees = useCallback(
    () => client.getQueryData<ResearchTreeSummary[]>(listKey) ?? EMPTY_TREES,
    // The key's contents are the workspace id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, workspaceId],
  );
  const currentState = useCallback(
    () =>
      client.getQueryData<ResearchFolderState>(queryKeys.folders(workspaceId)) ??
      EMPTY_FOLDER_STATE,
    [client, workspaceId],
  );
  const commit = useCallback(
    (update: (current: ResearchFolderState) => ResearchFolderState) =>
      commitFolderState(client, workspaceId, update),
    [client, workspaceId],
  );

  const findTree = useCallback(
    (treeId: string) => currentTrees().find((tree) => tree.id === treeId) ?? null,
    [currentTrees],
  );

  /** Writes the active threads' flat order: in the lists at once, then on the
   * server; a refusal refetches the lists. */
  const writeOrder = useCallback(
    async (order: string[]) => {
      eachTreeList(client, (summaries) => withActiveOrder(summaries, workspaceId, order));
      try {
        await reorderResearchTrees({ workspaceId, archived: false, treeIds: order });
      } catch (failure) {
        invalidateKeys(client, ["trees"]);
        throw failure;
      }
    },
    [client, workspaceId],
  );

  /** A place's threads (Archive: the archived ones), in the flat order. */
  const placeTrees = useCallback(
    (place: string, state: ResearchFolderState) =>
      currentTrees().filter((tree) =>
        place === RESEARCH_ARCHIVE_FOLDER_ID
          ? tree.archivedAt != null
          : tree.archivedAt == null && researchTreePlace(tree, state) === place,
      ),
    [currentTrees],
  );

  const topLevelIds = useCallback(
    (place: string, state: ResearchFolderState) =>
      researchTreeGroups(placeTrees(place, state), state.parents).map((group) => group.tree.id),
    [placeTrees],
  );

  const moveTree = useCallback<Filing["moveTree"]>(
    async (treeId, place, position = null, options = {}) => {
      const { toast = true, newFolderName = null, rejects = false } = options;
      const tree = findTree(treeId);
      if (!tree) return;
      const state = currentState();
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
      const childIds = researchChildIds(treeId, placeTrees(from, state), state.parents);
      const members = [tree, ...childIds.flatMap((id) => findTree(id) ?? [])];
      const previousMembers = new Map(
        members.map((member) => [member.id, state.membership[member.id] ?? null]),
      );
      const wasArchived = tree.archivedAt != null;
      const previousOrder = activeOrder(currentTrees());
      try {
        if (place !== RESEARCH_ARCHIVE_FOLDER_ID) {
          await commit((current) => {
            let next = newFolderName
              ? researchFolderStateWithNewFolder(current, newFolderName, workspaceId, place).state
              : current;
            if (leaves) next = researchFolderStateWithParent(next, treeId, null);
            for (const member of members) {
              next = researchFolderStateWithMembership(next, member.id, place);
            }
            return next;
          });
        }
        // The server archives and unarchives the children with their parent.
        const archive = place === RESEARCH_ARCHIVE_FOLDER_ID;
        if (archive && !wasArchived) await archiveResearchTree(treeId);
        else if (!archive && wasArchived) await restoreResearchTree(treeId);
        if (reorderable && (position || (from !== place && place !== RESEARCH_UNFILED_FOLDER_ID))) {
          const flat = activeOrder(currentTrees());
          const withTree = flat.includes(treeId) ? flat : [treeId, ...flat];
          const topLevel = topLevelIds(place, currentState());
          const order = researchTreeOrderAfterMove(
            withTree,
            topLevel,
            treeId,
            position ? researchDropBeforeId(topLevel, treeId, position) : null,
          );
          if (order.length === flat.length && order.some((id, index) => id !== flat[index])) {
            await writeOrder(order);
          }
        }
      } catch (failure) {
        if (rejects) throw failure;
        pushErrorToast("Couldn’t move the question", failure);
        return;
      }
      if (from === place || !toast) return;
      const name = researchPlaceName(place, currentState().folders);
      const withChildren =
        childIds.length > 0 ? ` with its ${researchChildCount(childIds.length)}` : "";
      const stillRunning =
        place === RESEARCH_ARCHIVE_FOLDER_ID && members.some((member) => member.runningCount > 0)
          ? " It's still running; the answer will appear there."
          : "";
      pushToast({
        title: `Moved to ${name}${withChildren}.`,
        ...(stillRunning ? { body: stillRunning.trim() } : {}),
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
              if (wasArchived && place !== RESEARCH_ARCHIVE_FOLDER_ID) {
                await archiveResearchTree(treeId);
              } else if (!wasArchived && place === RESEARCH_ARCHIVE_FOLDER_ID) {
                await restoreResearchTree(treeId);
              }
              const current = activeOrder(currentTrees());
              if (
                !wasArchived &&
                current.length === previousOrder.length &&
                current.some((id, index) => id !== previousOrder[index])
              ) {
                await writeOrder(previousOrder);
              }
            } catch (failure) {
              pushErrorToast("Couldn’t undo the move", failure);
            }
          })();
        },
      });
    },
    [
      commit,
      currentState,
      currentTrees,
      findTree,
      placeTrees,
      topLevelIds,
      workspaceId,
      writeOrder,
    ],
  );

  const nestTree = useCallback<Filing["nestTree"]>(
    async (treeId, parentId, beforeId = null, { flatten = false } = {}) => {
      const tree = findTree(treeId);
      const parent = findTree(parentId);
      if (!tree || !parent) return false;
      const state = currentState();
      if (researchNestRefusal(treeId, parentId, state.parents) || state.parents[parentId]) {
        return false;
      }
      if (!researchTreeHoldsChildren(parent.type)) return false;
      const parentPlace = researchTreePlace(parent, state);
      if (parentPlace === RESEARCH_ARCHIVE_FOLDER_ID) return false;
      const from = researchTreePlace(tree, state);
      const ownChildIds = researchChildIds(treeId, placeTrees(from, state), state.parents);
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
      const previousOrder = activeOrder(currentTrees());
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
          placeTrees(parentPlace, state),
          state.parents,
        ).filter((id) => !previous.has(id));
        const flat = activeOrder(currentTrees());
        let order = flat;
        for (const member of members) {
          if (!order.includes(member.id)) order = [...order, member.id];
          order = researchOrderAfterNest(order, parentId, siblings, member.id, beforeId);
          if (beforeId === null) siblings.push(member.id);
        }
        if (order.length === flat.length && order.some((id, index) => id !== flat[index])) {
          await writeOrder(order);
        }
      } catch (failure) {
        pushErrorToast("Couldn’t move the question", failure);
        return false;
      }
      if (!changesParent) return true;
      const withChildren =
        ownChildIds.length > 0 ? ` with its ${researchChildCount(ownChildIds.length)}` : "";
      pushToast({
        title: `Moved under “${parent.title}”${withChildren}.`,
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
              const current = activeOrder(currentTrees());
              if (
                current.length === previousOrder.length &&
                current.some((id, index) => id !== previousOrder[index])
              ) {
                await writeOrder(previousOrder);
              }
            } catch (failure) {
              pushErrorToast("Couldn’t undo the move", failure);
            }
          })();
        },
      });
      return true;
    },
    [commit, currentState, currentTrees, findTree, placeTrees, writeOrder],
  );

  const moveOutOfGroup = useCallback<Filing["moveOutOfGroup"]>(
    async (treeId) => {
      const tree = findTree(treeId);
      const state = currentState();
      const parentId = state.parents[treeId];
      if (!tree || !parentId) return false;
      const place = researchTreePlace(tree, state);
      const topLevel = topLevelIds(place, state);
      const siblings = researchChildIds(parentId, placeTrees(place, state), state.parents).filter(
        (id) => id !== treeId,
      );
      const previousOrder = activeOrder(currentTrees());
      try {
        await commit((current) => researchFolderStateWithParent(current, treeId, null));
        if (researchPlaceIsReorderable(place)) {
          const order = researchOrderAfterMoveOut(
            previousOrder,
            topLevel,
            parentId,
            treeId,
            siblings,
          );
          if (order.some((id, index) => id !== previousOrder[index])) {
            await writeOrder(order);
          }
        }
      } catch (failure) {
        pushErrorToast("Couldn’t move the question", failure);
        return false;
      }
      return true;
    },
    [commit, currentState, currentTrees, findTree, placeTrees, topLevelIds, writeOrder],
  );

  const setGroupsCollapsed = useCallback(
    (parentIds: readonly string[], collapsed: boolean) => {
      void commit((current) =>
        parentIds.reduce(
          (state, parentId) => researchFolderStateWithGroupCollapsed(state, parentId, collapsed),
          current,
        ),
      ).catch((failure: unknown) => pushErrorToast("Couldn’t save the group", failure));
    },
    [commit],
  );

  /** After a child was restored (from the Archive or the Trash) without its
   * parent: it rejoins the group when the parent is listed outside the
   * Archive and the Trash; otherwise it is listed on its own. */
  const settleRestoredChild = useCallback(
    async (treeId: string) => {
      const parentId = currentState().parents[treeId];
      if (!parentId) return;
      const parent = findTree(parentId);
      const listed = parent !== null && parent.archivedAt == null;
      await commit((current) =>
        researchFolderStateWithParent(current, treeId, listed ? parentId : null),
      );
    },
    [commit, currentState, findTree],
  );

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

  const deleteFolder = useCallback(
    async (folderId: string) => {
      try {
        await commit((current) => researchFolderStateWithoutFolder(current, folderId));
        return true;
      } catch (failure) {
        pushErrorToast("Couldn’t delete the folder", failure);
        return false;
      }
    },
    [commit],
  );

  const setFolderTrashed = useCallback(
    (folderId: string, trashed: boolean) =>
      commit((current) =>
        researchFolderStateWithFolderTrashed(current, folderId, trashed ? Date.now() : null),
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

  const fileNewTree = useCallback(
    (treeId: string, place: string) => {
      void commit((current) => researchFolderStateWithMembership(current, treeId, place)).catch(
        (failure: unknown) => pushErrorToast("Couldn’t file the question", failure),
      );
    },
    [commit],
  );

  return {
    workspaceId,
    folderState,
    folders,
    trees,
    foldersLoadError: folderQuery.isError ? errorMessage(folderQuery.error) : null,
    retryFoldersLoad: () => void folderQuery.refetch(),
    findTree,
    moveTree,
    nestTree,
    moveOutOfGroup,
    setGroupsCollapsed,
    settleRestoredChild,
    createFolder,
    moveTreeToNewFolder,
    renameFolder,
    deleteFolder,
    setFolderTrashed,
    setTrayCollapsed,
    fileNewTree,
  };
}
