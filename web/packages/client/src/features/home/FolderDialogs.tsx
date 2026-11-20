// New folder / Rename folder and the folder delete confirmation (the
// desktop's `ResearchFolderDialogs.tsx`). A new folder has no default name:
// the field starts empty, as on the desktop, so a second New folder cannot
// collide with the first. The name is checked here with the shared rule, and
// the server's refusal (`folders.set`) shows under the field with the typed
// name kept.

import type { ResearchFolder } from "@session/shared";
import {
  normalizeResearchFolderName,
  researchFolderNameError,
} from "@session/shared/lib/researchFolders";
import { researchTrashFolderSentence } from "@session/shared/lib/researchTrash";
import { useId, useRef, useState } from "react";

import { errorMessage } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";
import type { DeleteDialogProps } from "../../ui/DeleteDialog.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { INPUT_FIELD } from "../../ui/surfaces.js";

export type FolderNameRequest =
  | { kind: "create"; moveTreeId?: string | null }
  | { kind: "rename"; folderId: string; name: string };

export function FolderNameDialog({
  request,
  folders,
  onSubmit,
  onClose,
}: {
  request: FolderNameRequest;
  folders: ResearchFolder[];
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(request.kind === "rename" ? request.name : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const renamingId = request.kind === "rename" ? request.folderId : null;
  const moving = request.kind === "create" && Boolean(request.moveTreeId);
  const title = request.kind === "rename" ? "Rename folder" : "New folder";
  const submitLabel = request.kind === "rename" ? "Rename" : moving ? "Create and move" : "Create";

  async function submit() {
    if (busy) return;
    const problem = researchFolderNameError(value, folders, renamingId);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(normalizeResearchFolderName(value));
    } catch (failure) {
      setError(errorMessage(failure));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      initialFocus={inputRef}
      {...(moving ? { description: "The question moves into it once it's created." } : {})}
    >
      <form
        noValidate
        aria-busy={busy}
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          ref={inputRef}
          className={INPUT_FIELD}
          autoComplete="off"
          spellCheck={false}
          placeholder="Folder name"
          aria-label="Folder name"
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
        />
        {error ? (
          <p id={errorId} className="text-status-failed mt-2 mb-0 text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <ControlButton disabled={busy} onClick={onClose}>
            Cancel
          </ControlButton>
          <ConfirmDialogActionButton
            type="submit"
            pending={busy}
            pendingLabel={request.kind === "rename" ? "Renaming…" : "Creating…"}
          >
            {submitLabel}
          </ConfirmDialogActionButton>
        </div>
      </form>
    </Dialog>
  );
}

/** The folder delete confirmation's steps: Move to Trash (the default), or
 * Delete now, after which its questions are Unfiled. `count` includes
 * archived questions, which leave the folder too. */
export function folderDeleteDialogProps({
  name,
  count,
  onTrash,
  onDelete,
  onCancel,
}: {
  name: string;
  count: number;
  onTrash: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onCancel: () => void;
}): DeleteDialogProps {
  return {
    trash: {
      title: `Delete “${name}”?`,
      body: <p className="m-0">{researchTrashFolderSentence(count)}</p>,
      onConfirm: onTrash,
    },
    remove: {
      body: (
        <p className="m-0">
          {count > 0
            ? `Its ${count} question${count === 1 ? "" : "s"} move${count === 1 ? "s" : ""} to Unfiled. `
            : ""}
          This can’t be undone.
        </p>
      ),
      onConfirm: onDelete,
    },
    onClose: onCancel,
  };
}
