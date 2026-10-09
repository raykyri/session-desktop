import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { ResearchTreeSummary } from "../../types";
import { ResearchMenuItem, ResearchMenuSeparator } from "./ResearchMenu";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";

/** The items of a feed card's context menu. A and D select Archive and
 * Delete while the menu is open. */
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
  /** Each lifecycle action renders only when its handler is passed: Rename
   * and Archive on active rows, Unarchive on archived rows. */
  onRename?: (tree: ResearchTreeSummary) => void;
  onArchive?: (treeId: string) => void;
  onRestore?: (treeId: string) => void;
  onDelete: (tree: ResearchTreeSummary) => void;
  /** Query-specific action used by Home's research activity menu. */
  onRegenerateSummary?: () => void;
}) {
  const running = tree.runningCount > 0;
  return (
    <>
      {onRegenerateSummary ? (
        <>
          <ResearchMenuItem
            icon={<RefreshCw size={15} aria-hidden="true" />}
            label="Generate summary"
            onSelect={() => {
              onClose();
              onRegenerateSummary();
            }}
          />
          <ResearchMenuSeparator />
        </>
      ) : null}
      {archived ? (
        onRestore ? (
          <ResearchMenuItem
            icon={<ArchiveRestore size={15} aria-hidden="true" />}
            label="Unarchive research"
            onSelect={() => {
              onClose();
              onRestore(tree.id);
            }}
          />
        ) : null
      ) : (
        <>
          {onRename ? (
            <ResearchMenuItem
              icon={<Pencil size={15} aria-hidden="true" />}
              label="Rename"
              onSelect={() => {
                onClose();
                onRename(tree);
              }}
            />
          ) : null}
          {onArchive ? (
            <>
              <ResearchMenuSeparator />
              <ResearchMenuItem
                icon={<Archive size={15} aria-hidden="true" />}
                label="Archive"
                shortcut="A"
                disabled={running}
                title={running ? "Research with active runs cannot be archived" : undefined}
                onSelect={() => {
                  onClose();
                  onArchive(tree.id);
                }}
              />
            </>
          ) : null}
        </>
      )}
      <ResearchMenuItem
        icon={<Trash2 size={15} aria-hidden="true" />}
        label="Delete"
        shortcut="D"
        danger
        disabled={running}
        title={running ? "Research with active runs cannot be deleted" : undefined}
        onSelect={() => {
          onClose();
          onDelete(tree);
        }}
      />
    </>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useResearchDialogReturnFocus(true);
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
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-research-dialog-title"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
            return;
          }
          trapResearchDialogTab(event);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) {
            return;
          }
          if (!trimmed || trimmed === tree.title) {
            onClose();
            return;
          }
          setBusy(true);
          setError(null);
          // A failed rename keeps the dialog and the typed title.
          void onRename(tree.id, trimmed)
            .then(onClose)
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
              inputRef.current?.focus();
            })
            .finally(() => setBusy(false));
        }}
      >
        <h2 id="rename-research-dialog-title">Rename research</h2>
        <input
          ref={inputRef}
          className="rename-dialog-input"
          value={draft}
          aria-label="Research title"
          disabled={busy}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="control-button" type="submit" disabled={busy}>
            {busy ? "Renaming…" : "Rename"}
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
  useResearchDialogReturnFocus(true);
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
            return;
          }
          trapResearchDialogTab(event);
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
