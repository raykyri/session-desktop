import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { ResearchTreeSummary } from "../../types";

export const RESEARCH_TREE_MENU_WIDTH = 190;

export function ResearchTreeMenuItems({
  tree,
  archived,
  onClose,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  onRegenerateSummary,
}: {
  tree: ResearchTreeSummary;
  archived: boolean;
  onClose: () => void;
  onRename: (tree: ResearchTreeSummary) => void;
  onArchive: (treeId: string) => void;
  /** Only reached from archived rows; surfaces without archived rows omit it. */
  onRestore?: (treeId: string) => void;
  onDelete: (tree: ResearchTreeSummary) => void;
  /** Query-specific action used by Home's research activity menu. */
  onRegenerateSummary?: () => void;
}) {
  const running = tree.runningCount > 0;
  return (
    <div className="group-context-actions">
      {onRegenerateSummary ? (
        <>
          <button
            className="control-button"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onRegenerateSummary();
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span>Generate summary</span>
          </button>
          <div className="context-menu-divider" role="separator" />
        </>
      ) : null}
      {archived ? (
        onRestore ? (
          <button
            className="control-button"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onRestore(tree.id);
            }}
          >
            <ArchiveRestore size={13} aria-hidden="true" />
            <span>Unarchive research</span>
          </button>
        ) : null
      ) : (
        <>
          <button
            className="control-button"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onRename(tree);
            }}
          >
            <Pencil size={13} aria-hidden="true" />
            <span>Rename</span>
          </button>
          <div className="context-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="control-button context-menu-has-shortcut"
            disabled={running}
            title={running ? "Research with active runs cannot be archived" : undefined}
            onClick={() => {
              onClose();
              onArchive(tree.id);
            }}
          >
            <Archive size={13} aria-hidden="true" />
            <span>Archive</span>
            <kbd className="context-menu-shortcut is-keycap">A</kbd>
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        className="control-button context-menu-danger context-menu-has-shortcut"
        disabled={running}
        title={running ? "Research with active runs cannot be deleted" : undefined}
        onClick={() => {
          onClose();
          onDelete(tree);
        }}
      >
        <Trash2 size={13} aria-hidden="true" />
        <span>Delete</span>
        <kbd className="context-menu-shortcut is-keycap">D</kbd>
      </button>
    </div>
  );
}

export function ResearchTreeRenameDialog({
  tree,
  onClose,
  onRename,
}: {
  tree: ResearchTreeSummary;
  onClose: () => void;
  onRename: (treeId: string, title: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(tree.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = draft.trim();
  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-research-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || trimmed === tree.title) {
            onClose();
            return;
          }
          void onRename(tree.id, trimmed);
          onClose();
        }}
      >
        <h2 id="rename-research-dialog-title">Rename research</h2>
        <input
          ref={inputRef}
          className="rename-dialog-input"
          value={draft}
          aria-label="Research title"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="control-button" type="submit">
            Rename
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function ResearchTreeDeleteDialog({
  tree,
  onClose,
  onRemove,
}: {
  tree: ResearchTreeSummary;
  onClose: () => void;
  onRemove: (treeId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-research-dialog-title"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="delete-research-dialog-title">Delete “{tree.title}”?</h2>
        <p>
          This permanently deletes this research and its completed work and follow-up
          history. This can’t be undone.
        </p>
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="control-button danger"
            autoFocus
            disabled={busy}
            onClick={() => {
              if (busy) {
                return;
              }
              setError(null);
              setBusy(true);
              void onRemove(tree.id)
                .then(() => {
                  onClose();
                })
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {busy ? "Deleting…" : "Delete research"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
