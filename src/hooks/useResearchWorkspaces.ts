import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ResearchData } from "./useResearchData";
import type { ResearchNavigation } from "./useResearchNavigation";
import {
  createResearchWorkspaceWithFolder,
  moveResearchWorkspaceWithFolder,
  removeResearchWorkspace,
  renameResearchWorkspace,
  revealResearchWorkspace,
} from "../lib/api";
import { waitForNextPaint } from "../lib/appHelpers";
import { defaultGroupName, displayGroupName } from "../lib/groupNames";
import {
  treeForResearchScope,
  treesForResearchScope,
  type ResearchWorkspaceScope,
} from "../lib/researchScope";
import type { GroupInfo, RuntimeConfig } from "../types";

interface ResearchWorkspaceContext {
  groups: GroupInfo[];
  setGroups: Dispatch<SetStateAction<GroupInfo[]>>;
  groupsRef: { current: GroupInfo[] };
  config: RuntimeConfig | null;
  /** The sidebar's workspace. */
  researchScope: ResearchWorkspaceScope;
  changeResearchWorkspaceScope: (scope: ResearchWorkspaceScope) => void;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Research workspaces (the folders research lives in): switching the
 * sidebar's workspace, adding, revealing, moving, renaming and removing one,
 * with the rename and removal dialogs' state.
 */
export function useResearchWorkspaces(
  data: ResearchData,
  navigation: ResearchNavigation,
  {
    groups,
    setGroups,
    groupsRef,
    config,
    researchScope,
    changeResearchWorkspaceScope,
    setError,
  }: ResearchWorkspaceContext,
) {
  const {
    researchTreesRef,
    archivedResearchTreesRef,
    activeResearchTreeIdRef,
    setResearchTrees,
    setArchivedResearchTrees,
    setResearchActivity,
    clearActiveResearchTree,
  } = data;
  const {
    navigateToResearchThread,
    recordResearchVisit,
    focusResearchHome,
    pruneResearchTreeVisits,
    refreshResearchNavigation,
  } = navigation;
  const researchScopeRef = useRef(researchScope);
  researchScopeRef.current = researchScope;
  const workspaceRoot = config?.workspaceRoot;
  const homeDir = config?.homeDir;
  const groupDirRoots = useMemo(() => ({ workspaceRoot, homeDir }), [workspaceRoot, homeDir]);
  /** The name a workspace shows. */
  const workspaceName = (workspace: GroupInfo) => displayGroupName(workspace, groupDirRoots);

  // Shown while the native folder picker is open.
  const [folderPickerStatus, setFolderPickerStatus] = useState<string | null>(null);
  // The research workspace whose removal the confirmation dialog asks about.
  const [removal, setRemoval] = useState<GroupInfo | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  // True while the removal runs, so the dialog stays open (and its buttons
  // disabled) until the operation finishes.
  const [removing, setRemoving] = useState(false);
  // The group the rename dialog edits, with the name it opened with.
  const [renameRequest, setRenameRequest] = useState<{ groupId: string; name: string } | null>(
    null,
  );

  // Switching the sidebar's workspace keeps the open thread inside it: a
  // thread outside the new workspace is replaced by the workspace's remembered
  // or first thread, or by Home.
  const selectWorkspace = useCallback(
    (scope: ResearchWorkspaceScope) => {
      changeResearchWorkspaceScope(scope);
      const activeTreeId = activeResearchTreeIdRef.current;
      if (activeTreeId === null) {
        return;
      }
      const allTrees = [...researchTreesRef.current, ...archivedResearchTreesRef.current];
      const activeInScope = treesForResearchScope(allTrees, scope).some(
        (tree) => tree.id === activeTreeId,
      );
      if (!activeInScope) {
        const tree = treeForResearchScope(allTrees, scope, activeTreeId);
        if (tree) {
          navigateToResearchThread(tree.id);
        } else {
          recordResearchVisit({ kind: "home" });
          clearActiveResearchTree();
        }
      }
    },
    [
      activeResearchTreeIdRef,
      archivedResearchTreesRef,
      changeResearchWorkspaceScope,
      clearActiveResearchTree,
      navigateToResearchThread,
      recordResearchVisit,
      researchTreesRef,
    ],
  );

  const chooseWorkspaceFolder = useCallback(async (): Promise<GroupInfo | null> => {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForNextPaint();
      const workspace = await createResearchWorkspaceWithFolder();
      if (workspace) {
        setGroups((current) =>
          current.some((group) => group.id === workspace.id) ? current : [...current, workspace],
        );
        void refreshResearchNavigation().catch(() => undefined);
      }
      return workspace;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setFolderPickerStatus(null);
    }
  }, [refreshResearchNavigation, setError, setGroups]);
  const openWorkspaceFolder = useCallback(
    async (workspace: GroupInfo) => {
      setError(null);
      try {
        await revealResearchWorkspace(workspace.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [setError],
  );
  const moveWorkspaceFolder = useCallback(
    async (workspace: GroupInfo) => {
      setError(null);
      setFolderPickerStatus("Opening folder picker…");
      try {
        await waitForNextPaint();
        const updated = await moveResearchWorkspaceWithFolder(workspace.id);
        if (updated) {
          setGroups((current) =>
            current.map((group) => (group.id === updated.id ? updated : group)),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setFolderPickerStatus(null);
      }
    },
    [setError, setGroups],
  );

  // Research workspaces are the only groups any surface renames.
  const openRename = useCallback(
    (group: GroupInfo) => {
      setRenameRequest({
        groupId: group.id,
        name: displayGroupName(group, groupDirRoots),
      });
    },
    [groupDirRoots],
  );
  const closeRename = useCallback(() => setRenameRequest(null), []);

  async function submitRename(groupId: string, name: string) {
    const title = name.trim();
    const previous = groups.find((group) => group.id === groupId);
    const nextNameOverride = title.length === 0 ? null : title;
    closeRename();
    if (!previous) {
      return;
    }
    const previousNameOverride = previous.nameOverride?.trim() || null;
    if (
      previousNameOverride === nextNameOverride ||
      (previousNameOverride === null &&
        nextNameOverride === defaultGroupName(previous, groupDirRoots))
    ) {
      return;
    }

    setGroups((current) =>
      current.map((group) =>
        group.id === groupId ? { ...group, nameOverride: nextNameOverride } : group,
      ),
    );
    try {
      const updated = await renameResearchWorkspace(groupId, nextNameOverride);
      setGroups((current) =>
        current.map((group) => (group.id === groupId ? updated : group)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGroups((current) =>
        current.map((group) => (group.id === groupId ? previous : group)),
      );
    }
  }

  const requestRemoval = useCallback((workspace: GroupInfo) => {
    setRemovalError(null);
    setRemoval(workspace);
  }, []);
  const closeRemoval = useCallback(() => setRemoval(null), []);

  async function removeWorkspace(workspace: GroupInfo) {
    setError(null);
    const detachedTreeIds = new Set(await removeResearchWorkspace(workspace.id));
    const remainingGroups = groupsRef.current.filter((group) => group.id !== workspace.id);
    const remainingTrees = researchTreesRef.current.filter(
      (tree) => !detachedTreeIds.has(tree.id),
    );
    setGroups(remainingGroups);
    setResearchTrees(remainingTrees);
    setArchivedResearchTrees((current) =>
      current.filter((tree) => !detachedTreeIds.has(tree.id)),
    );
    setResearchActivity((current) =>
      current.filter((node) => !detachedTreeIds.has(node.treeId)),
    );
    const activeTreeId = activeResearchTreeIdRef.current;
    const activeTreeWasRemoved = Boolean(activeTreeId && detachedTreeIds.has(activeTreeId));
    const scopeWasRemoved = researchScopeRef.current === workspace.id;
    const nextScope = scopeWasRemoved
      ? (remainingGroups.find(
          (group) => group.scope === "research" && group.id !== workspace.id,
        )?.id ?? null)
      : researchScopeRef.current;
    if (scopeWasRemoved) {
      changeResearchWorkspaceScope(nextScope);
    }
    // After removing the selected folder or tree, select an available item in
    // the remaining scope so the thread page is not empty.
    if (scopeWasRemoved || activeTreeWasRemoved) {
      const nextTree = treeForResearchScope(
        remainingTrees,
        nextScope,
        activeTreeWasRemoved ? null : activeTreeId,
      );
      if (nextTree) {
        navigateToResearchThread(nextTree.id);
      } else {
        focusResearchHome();
      }
    }
    pruneResearchTreeVisits((id) => !detachedTreeIds.has(id));
    void refreshResearchNavigation().catch(() => undefined);
  }

  async function confirmRemoval() {
    const workspace = removal;
    if (!workspace || removing) {
      return;
    }
    setRemovalError(null);
    setRemoving(true);
    try {
      await removeWorkspace(workspace);
      setRemoval(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRemovalError(message);
      setError(message);
    } finally {
      setRemoving(false);
    }
  }

  return {
    workspaceName,
    folderPickerStatus,
    selectWorkspace,
    chooseWorkspaceFolder,
    openWorkspaceFolder,
    moveWorkspaceFolder,
    renameRequest,
    openRename,
    closeRename,
    submitRename,
    removal,
    removalError,
    removing,
    requestRemoval,
    closeRemoval,
    confirmRemoval,
  };
}
