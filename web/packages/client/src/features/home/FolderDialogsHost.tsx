// The folder dialogs (the desktop's `useResearchFolderDialogs`): the name
// dialog that creates or renames a folder, optionally moving a question into
// the new one, and the delete confirmation, shown over the folder's own view.
// The sidebar, Home's "+ New folder" link, a card's "New folder…" and a
// folder view's header all open them, so their state is a store and one host
// in the shell renders them.

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { create } from "zustand";

import { errorMessage, pushToast } from "../../lib/toast.js";
import { DeleteDialog } from "../../ui/DeleteDialog.js";
import { useWorkspaceScope } from "../sidebar/scope.js";

import {
  folderDeleteDialogProps,
  FolderNameDialog,
  type FolderNameRequest,
} from "./FolderDialogs.js";
import { useFiling } from "./useFiling.js";

interface FolderDialogState {
  nameRequest: FolderNameRequest | null;
  /** The folder whose delete confirmation is open, over its folder view. */
  pendingDelete: string | null;
  /** Where focus returns once the dialog closes. */
  returnFocus: HTMLElement | null;
  openNew: (moveTreeId?: string | null, trigger?: HTMLElement | null) => void;
  openRename: (folderId: string, name: string, trigger?: HTMLElement | null) => void;
  closeName: () => void;
  setPendingDelete: (folderId: string | null) => void;
}

export const useFolderDialogStore = create<FolderDialogState>()((set) => ({
  nameRequest: null,
  pendingDelete: null,
  returnFocus: null,
  openNew: (moveTreeId = null, trigger = null) =>
    set({ nameRequest: { kind: "create", moveTreeId }, returnFocus: trigger }),
  openRename: (folderId, name, trigger = null) =>
    set({ nameRequest: { kind: "rename", folderId, name }, returnFocus: trigger }),
  closeName: () => set({ nameRequest: null }),
  setPendingDelete: (pendingDelete) => set({ pendingDelete }),
}));

/** Opens a folder's delete confirmation over its own view, where the
 * confirmation states how many questions move to Unfiled. */
export function useRequestFolderDelete(): (folderId: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (folderId: string) => {
      void navigate({
        to: "/f/$folderId",
        params: { folderId },
        search: (previous: Record<string, unknown>) => ({
          ws: previous["ws"] as string | undefined,
        }),
      });
      useFolderDialogStore.getState().setPendingDelete(folderId);
    },
    [navigate],
  );
}

/** Renders the open folder dialog for the scoped workspace. Mounted once, in
 * the shell. */
export function FolderDialogsHost() {
  const { workspaceId } = useWorkspaceScope();
  if (workspaceId === "") return null;
  return <FolderDialogsFor workspaceId={workspaceId} />;
}

function FolderDialogsFor({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const filing = useFiling(workspaceId);
  const nameRequest = useFolderDialogStore((state) => state.nameRequest);
  const pendingDelete = useFolderDialogStore((state) => state.pendingDelete);
  const store = useFolderDialogStore.getState;

  const goHome = () =>
    void navigate({
      to: "/",
      search: (previous: Record<string, unknown>) => ({ ws: previous["ws"] as string | undefined }),
    });

  const closeName = () => {
    const focus = store().returnFocus;
    store().closeName();
    requestAnimationFrame(() => {
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    });
  };

  const submitName = async (name: string) => {
    const request = store().nameRequest;
    if (!request) return;
    if (request.kind === "rename") {
      await filing.renameFolder(request.folderId, name);
      closeName();
      pushToast({ title: "Renamed." });
      return;
    }
    if (request.moveTreeId) {
      await filing.moveTreeToNewFolder(request.moveTreeId, name);
      closeName();
      return;
    }
    const folder = await filing.createFolder(name);
    closeName();
    if (folder) pushToast({ title: `Created ${folder.name}.` });
  };

  const folder = pendingDelete
    ? (filing.folders.find((candidate) => candidate.id === pendingDelete) ?? null)
    : null;
  const count = folder
    ? filing.trees.filter((tree) => filing.folderState.membership[tree.id] === folder.id).length
    : 0;

  return (
    <>
      {nameRequest ? (
        <FolderNameDialog
          request={nameRequest}
          folders={filing.folders}
          onSubmit={submitName}
          onClose={closeName}
        />
      ) : null}
      {folder ? (
        <DeleteDialog
          {...folderDeleteDialogProps({
            name: folder.name,
            count,
            // The default: the folder moves to the Trash and its questions
            // keep their membership, so Undo or Restore lists them in it
            // again.
            onTrash: async () => {
              await filing.setFolderTrashed(folder.id, true);
              goHome();
              pushToast({
                title: "Moved the folder to the Trash.",
                undo: () =>
                  void filing
                    .setFolderTrashed(folder.id, false)
                    .catch((failure: unknown) =>
                      pushToast({ title: errorMessage(failure), tone: "warning" }),
                    ),
              });
            },
            // Delete now: the folder is deleted and its questions are Unfiled.
            onDelete: async () => {
              const deleted = await filing.deleteFolder(folder.id);
              if (!deleted) return;
              goHome();
              pushToast({
                title: `Deleted folder.${
                  count ? ` ${count} question${count === 1 ? "" : "s"} moved to Unfiled.` : ""
                }`,
              });
            },
            onCancel: () => store().setPendingDelete(null),
          })}
        />
      ) : null}
    </>
  );
}
