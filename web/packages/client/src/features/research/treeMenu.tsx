// The per-thread menu rows and the two dialogs behind them
// (`09-research-document-view.md` §8, `08-design-system-and-styling.md` §4).
//
// Shared surface, deliberately: the same rows appear on a sidebar row's
// context menu, on a Home card's `⋯`, and in the document's own node menu, and
// three copies of "Archive is refused while a run is in flight" is three places
// for that rule to rot. The component renders rows only — `MenuItem` and
// `MenuSeparator` — so a caller can drop them into `Menu` or `ContextMenu`
// without either owning the other's surface.
//
// Every action is a callback rather than a mutation call: what "delete" means
// differs by caller (the sidebar removes a row, the document navigates away),
// and the confirmation dialogs below are exported separately so a caller that
// already has one does not get a second.

import { isResearchStarred } from "@session/shared";
import type { ResearchFolderState, ResearchTreeSummary } from "@session/shared";
import { useState } from "react";

import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { Input } from "../../ui/Field.js";
import { MenuItem, MenuSeparator } from "../../ui/Menu.js";

export interface ResearchTreeMenuItemsProps {
  tree: ResearchTreeSummary;
  archived: boolean;
  /** Supplies the star and folder membership state; pass
   * `emptyResearchFolderState()` where folders are not offered. */
  folderState: ResearchFolderState;
  onToggleStar: (treeId: string) => void;
  onRename: (tree: ResearchTreeSummary) => void;
  onArchive: (treeId: string) => void;
  onRestore: (treeId: string) => void;
  onDelete: (tree: ResearchTreeSummary) => void;
  /** Omitted where folders are not offered (the document's own menu). */
  onRemoveFromFolder?: ((treeIds: string[]) => void) | undefined;
  onRequestCreateFolder?: ((treeIds: string[]) => void) | undefined;
  /** Home's query menu and the document's answer menu offer this; the sidebar
   * does not, because a tree is not a single answer. */
  onRegenerateSummary?: (() => void) | undefined;
}

/**
 * Rows for one thread. A thread with a run in flight cannot be archived or
 * deleted: both would have to cancel it first, and cancelling is a decision the
 * reader should make explicitly.
 */
export function ResearchTreeMenuItems({
  tree,
  archived,
  folderState,
  onToggleStar,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  onRemoveFromFolder,
  onRequestCreateFolder,
  onRegenerateSummary,
}: ResearchTreeMenuItemsProps) {
  const starred = isResearchStarred(folderState, tree.id);
  const inFolder = Boolean(folderState.membership[tree.id]);
  const running = tree.runningCount > 0;

  return (
    <>
      {onRegenerateSummary ? (
        <>
          <MenuItem onClick={onRegenerateSummary}>Generate summary</MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {archived ? (
        <MenuItem onClick={() => onRestore(tree.id)}>Unarchive research</MenuItem>
      ) : (
        <>
          <MenuItem onClick={() => onToggleStar(tree.id)}>{starred ? "Unstar" : "Star"}</MenuItem>
          <MenuItem onClick={() => onRename(tree)}>Rename</MenuItem>
          {inFolder && onRemoveFromFolder ? (
            <MenuItem onClick={() => onRemoveFromFolder([tree.id])}>Remove from folder</MenuItem>
          ) : null}
          {onRequestCreateFolder ? (
            <MenuItem onClick={() => onRequestCreateFolder([tree.id])}>
              New folder with item
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem disabled={running} onClick={() => onArchive(tree.id)}>
            Archive
          </MenuItem>
        </>
      )}
      <MenuItem tone="danger" disabled={running} onClick={() => onDelete(tree)}>
        Delete
      </MenuItem>
    </>
  );
}

export function RenameTreeDialog({
  tree,
  open,
  onClose,
  onRename,
}: {
  tree: ResearchTreeSummary | { id: string; title: string };
  open: boolean;
  onClose: () => void;
  onRename: (treeId: string, title: string) => void;
}) {
  const [draft, setDraft] = useState(tree.title);
  const trimmed = draft.trim();
  const submit = () => {
    if (trimmed && trimmed !== tree.title) onRename(tree.id, trimmed);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Rename research"
      footer={
        <>
          <ControlButton onClick={onClose}>Cancel</ControlButton>
          <ControlButton onClick={submit}>Rename</ControlButton>
        </>
      }
    >
      <Input
        // A rename dialog with one field: the field is the dialog.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={draft}
        aria-label="Research title"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        className="w-full"
      />
    </Dialog>
  );
}

export function DeleteTreeDialog({
  tree,
  open,
  busy = false,
  error = null,
  onClose,
  onRemove,
}: {
  tree: ResearchTreeSummary | { id: string; title: string };
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onRemove: (treeId: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={`Delete “${tree.title}”?`}
      description="This permanently deletes this research, its answers, and its follow-up history. This can’t be undone."
      footer={
        <>
          <ControlButton disabled={busy} onClick={onClose}>
            Cancel
          </ControlButton>
          <ConfirmDialogActionButton
            tone="danger"
            pending={busy}
            pendingLabel="Deleting…"
            onClick={() => onRemove(tree.id)}
          >
            Delete research
          </ConfirmDialogActionButton>
        </>
      }
    >
      {error ? (
        <p className="text-status-failed m-0 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
