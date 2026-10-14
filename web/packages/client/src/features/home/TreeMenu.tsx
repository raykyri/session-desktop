// A feed card's menu and the dialogs behind it: the desktop's
// `ResearchMoveMenu.tsx` (Move to, New folder…) and `ResearchTreeMenu.tsx`
// (Generate recap, Rename, Unarchive, Delete, and the rename and two-step
// delete confirmations).

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ResearchFolder, ResearchTreeSummary } from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "@session/shared/lib/researchFolders";
import { researchTrashTreeSentence } from "@session/shared/lib/researchTrash";
import { ArchiveRestore, House, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { errorMessage } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";
import type { DeleteDialogProps } from "../../ui/DeleteDialog.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { MenuGroupLabel, MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { INPUT_FIELD } from "../../ui/surfaces.js";
import { IconMenuItem } from "../sidebar/menuRows.js";

import { PlaceIcon } from "./FeedTray.js";

/** Every place a question can be moved to, in sidebar order. */
export function moveTargets(folders: ResearchFolder[]) {
  return [
    { place: RESEARCH_UNFILED_FOLDER_ID, name: "Unfiled" },
    { place: RESEARCH_DRAFTS_FOLDER_ID, name: "Drafts" },
    ...folders.map((folder) => ({ place: folder.id, name: folder.name })),
    { place: RESEARCH_ARCHIVE_FOLDER_ID, name: "Archive" },
  ];
}

/** Move to with every place (the current one checked and disabled), then
 * New folder…, which creates a folder and moves the question into it. */
export function MoveToItems({
  currentPlace,
  folders,
  onMove,
  onNewFolder,
}: {
  currentPlace: string;
  folders: ResearchFolder[];
  onMove: (place: string) => void;
  onNewFolder: () => void;
}) {
  return (
    <>
      <BaseMenu.Group>
        <MenuGroupLabel>Move to</MenuGroupLabel>
        {moveTargets(folders).map((target) => {
          const here = target.place === currentPlace;
          return (
            <MenuItem
              key={target.place}
              disabled={here}
              selected={here}
              onClick={() => onMove(target.place)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-fg-muted inline-flex shrink-0">
                  {target.place === RESEARCH_UNFILED_FOLDER_ID ? (
                    <House size={15} aria-hidden="true" />
                  ) : (
                    <PlaceIcon place={target.place} size={15} />
                  )}
                </span>
                <span className="truncate">{target.name}</span>
              </span>
            </MenuItem>
          );
        })}
      </BaseMenu.Group>
      <MenuSeparator />
      <IconMenuItem icon={<Plus size={15} aria-hidden="true" />} onClick={onNewFolder}>
        New folder…
      </IconMenuItem>
    </>
  );
}

/** A card's thread actions, the end of its menu: Generate recap and Rename,
 * a separator, then Unarchive (on an archived card) and Delete. */
export function TreeLifecycleItems({
  tree,
  archived,
  onRename,
  onRestore,
  onDelete,
  onRegenerateRecap,
}: {
  tree: ResearchTreeSummary;
  archived: boolean;
  onRename?: ((tree: ResearchTreeSummary) => void) | undefined;
  onRestore?: ((treeId: string) => void) | undefined;
  onDelete: (tree: ResearchTreeSummary) => void;
  /** Generate recap, for a card whose root has a recap. */
  onRegenerateRecap?: (() => void) | undefined;
}) {
  const running = tree.runningCount > 0;
  const rename = archived ? undefined : onRename;
  return (
    <>
      {onRegenerateRecap ? (
        <IconMenuItem icon={<RefreshCw size={15} aria-hidden="true" />} onClick={onRegenerateRecap}>
          Generate recap
        </IconMenuItem>
      ) : null}
      {rename ? (
        <IconMenuItem icon={<Pencil size={15} aria-hidden="true" />} onClick={() => rename(tree)}>
          Rename
        </IconMenuItem>
      ) : null}
      {onRegenerateRecap || rename ? <MenuSeparator /> : null}
      {archived && onRestore ? (
        <IconMenuItem
          icon={<ArchiveRestore size={15} aria-hidden="true" />}
          onClick={() => onRestore(tree.id)}
        >
          Unarchive research
        </IconMenuItem>
      ) : null}
      <IconMenuItem
        icon={<Trash2 size={15} aria-hidden="true" />}
        tone="danger"
        disabled={running}
        {...(running ? { hint: "Running" } : {})}
        onClick={() => onDelete(tree)}
      >
        Delete
      </IconMenuItem>
    </>
  );
}

/** Rename research: the title field, focused and selected. A failed rename
 * keeps the dialog and the typed title. */
export function TreeRenameDialog({
  tree,
  onClose,
  onRename,
}: {
  tree: ResearchTreeSummary;
  onClose: () => void;
  onRename: (treeId: string, title: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(tree.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmed = draft.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Rename research"
      initialFocus={inputRef}
    >
      <form
        className="flex flex-col"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (!trimmed || trimmed === tree.title) {
            onClose();
            return;
          }
          setBusy(true);
          setError(null);
          void onRename(tree.id, trimmed)
            .then(onClose)
            .catch((failure: unknown) => {
              setError(errorMessage(failure));
              inputRef.current?.focus();
            })
            .finally(() => setBusy(false));
        }}
      >
        <input
          ref={inputRef}
          className={INPUT_FIELD}
          value={draft}
          aria-label="Research title"
          disabled={busy}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        {error ? (
          <p className="text-status-failed mt-2 mb-0 text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <ControlButton disabled={busy} onClick={onClose}>
            Cancel
          </ControlButton>
          <ConfirmDialogActionButton type="submit" pending={busy} pendingLabel="Renaming…">
            Rename
          </ConfirmDialogActionButton>
        </div>
      </form>
    </Dialog>
  );
}

/** A thread's delete confirmation: Move to Trash (the default), with a
 * Delete now link to the permanent deletion. The children listed under it in
 * Home go with it. */
export function treeDeleteDialogProps({
  tree,
  groupChildren = [],
  onClose,
  onTrash,
  onRemove,
}: {
  tree: ResearchTreeSummary;
  groupChildren?: readonly ResearchTreeSummary[];
  onClose: () => void;
  onTrash: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
}): DeleteDialogProps {
  const count = groupChildren.length;
  const children = `${count} ${count === 1 ? "child" : "children"}`;
  return {
    trash: {
      title: count > 0 ? `Delete “${tree.title}” and its ${children}?` : `Delete “${tree.title}”?`,
      body: <p className="m-0">{researchTrashTreeSentence(null, count)}</p>,
      onConfirm: () => onTrash(tree.id),
    },
    remove: {
      ...(count > 0
        ? {
            body: (
              <p className="m-0">
                “{tree.title}” and its {children} will be deleted. This can’t be undone.
              </p>
            ),
          }
        : {}),
      onConfirm: () => onRemove(tree.id),
    },
    disabledReason:
      tree.runningCount > 0
        ? "It has active runs, which must finish or be cancelled before it can be deleted."
        : groupChildren.some((child) => child.runningCount > 0)
          ? `${count === 1 ? "Its child has" : "At least one of its children has"} active runs, which must finish or be cancelled before this thread can be deleted.`
          : null,
    onClose,
  };
}
