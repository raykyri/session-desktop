import { useCallback, useRef, useState } from "react";
import type { ResearchFolderNameRequest } from "../components/research/ResearchFolderDialogs";
import type { useResearchFiling } from "./useResearchFiling";
import type { useResearchToast } from "./useResearchToast";
import type { ResearchFeedPage } from "../lib/sidebarMode";
import type { ResearchTreeSummary } from "../types";

interface ResearchFolderDialogContext {
  filing: ReturnType<typeof useResearchFiling>;
  showToast: ReturnType<typeof useResearchToast>["showToast"];
  openFeedPage: (page: ResearchFeedPage) => void;
  researchTreesRef: { current: ResearchTreeSummary[] };
  archivedResearchTreesRef: { current: ResearchTreeSummary[] };
}

/**
 * The feed folders' dialogs: the name dialog that creates or renames a folder
 * (optionally moving a question into the new one), and the delete
 * confirmation shown in the folder's own view.
 */
export function useResearchFolderDialogs({
  filing,
  showToast,
  openFeedPage,
  researchTreesRef,
  archivedResearchTreesRef,
}: ResearchFolderDialogContext) {
  const { folders, folderState, renameFolder, moveTreeToNewFolder, createFolder, deleteFolder } =
    filing;
  const folderStateRef = useRef(folderState);
  folderStateRef.current = folderState;
  const [nameRequest, setNameRequest] = useState<ResearchFolderNameRequest | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // `trigger` is the button that opened the dialog (through a menu that is
  // gone by then); focus returns to it when the dialog closes.
  const openNew = useCallback((moveTreeId?: string, trigger?: HTMLElement) => {
    setNameRequest({
      kind: "create",
      moveTreeId: moveTreeId ?? null,
      returnFocus: trigger ?? null,
    });
  }, []);
  const openRename = useCallback(
    (folderId: string, trigger?: HTMLElement) => {
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (folder) {
        setNameRequest({
          kind: "rename",
          folderId,
          name: folder.name,
          returnFocus: trigger ?? null,
        });
      }
    },
    [folders],
  );
  const closeName = useCallback(() => setNameRequest(null), []);
  const submitName = useCallback(
    async (name: string) => {
      const request = nameRequest;
      if (!request) return;
      if (request.kind === "rename") {
        await renameFolder(request.folderId, name);
        setNameRequest(null);
        showToast("Renamed.");
        return;
      }
      if (request.moveTreeId) {
        await moveTreeToNewFolder(request.moveTreeId, name);
        setNameRequest(null);
        return;
      }
      const folder = await createFolder(name);
      setNameRequest(null);
      if (!folder) return;
      showToast(
        <span>
          Created <b>{folder.name}</b>.
        </span>,
      );
    },
    [createFolder, moveTreeToNewFolder, nameRequest, renameFolder, showToast],
  );
  // Deleting starts from the folder's own view, where the confirmation
  // states how many questions move to Unfiled.
  const requestDelete = useCallback(
    (folderId: string) => {
      openFeedPage({ kind: "folder", folderId });
      setPendingDelete(folderId);
    },
    [openFeedPage],
  );
  const confirmDelete = useCallback(
    (folderId: string) => {
      const moved = [...researchTreesRef.current, ...archivedResearchTreesRef.current].filter(
        (tree) => folderStateRef.current.membership[tree.id] === folderId,
      ).length;
      setPendingDelete(null);
      openFeedPage({ kind: "home" });
      void deleteFolder(folderId).then((deleted) => {
        if (!deleted) return;
        showToast(
          `Deleted folder.${
            moved ? ` ${moved} question${moved === 1 ? "" : "s"} moved to Unfiled.` : ""
          }`,
        );
      });
    },
    [archivedResearchTreesRef, deleteFolder, openFeedPage, researchTreesRef, showToast],
  );
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  return {
    nameRequest,
    openNew,
    openRename,
    closeName,
    submitName,
    pendingDelete,
    requestDelete,
    confirmDelete,
    cancelDelete,
  };
}
