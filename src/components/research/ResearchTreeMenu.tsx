import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArchiveRestore, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { ResearchTreeSummary } from "../../types";
import { researchTreeContentsSentence, type ResearchTreeContents } from "../../lib/researchTreeContents";
import { ResearchMenuItem, ResearchMenuSeparator } from "./ResearchMenu";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";

/** A feed card's thread actions, the end of its menu: Generate recap and
 * Rename, a separator, then Unarchive (on an archived card) and Delete. D
 * selects Delete while the menu is open. */
export function ResearchTreeLifecycleItems({
  tree,
  archived,
  onClose,
  onRename,
  onRestore,
  onDelete,
  onRegenerateRecap,
}: {
  tree: ResearchTreeSummary;
  archived: boolean;
  onClose: () => void;
  /** Each action renders only when its handler is passed and it applies:
   * Rename on active cards, Unarchive on archived cards. Archiving is the
   * Archive entry under Move to. */
  onRename?: (tree: ResearchTreeSummary) => void;
  onRestore?: (treeId: string) => void;
  onDelete: (tree: ResearchTreeSummary) => void;
  /** Generate recap, for a card whose root has a recap. */
  onRegenerateRecap?: () => void;
}) {
  const running = tree.runningCount > 0;
  const rename = archived ? undefined : onRename;
  return (
    <>
      {onRegenerateRecap ? (
        <ResearchMenuItem
          icon={<RefreshCw size={15} aria-hidden="true" />}
          label="Generate recap"
          onSelect={() => {
            onClose();
            onRegenerateRecap();
          }}
        />
      ) : null}
      {rename ? (
        <ResearchMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Rename"
          onSelect={() => {
            onClose();
            rename(tree);
          }}
        />
      ) : null}
      {onRegenerateRecap || rename ? <ResearchMenuSeparator /> : null}
      {archived && onRestore ? (
        <ResearchMenuItem
          icon={<ArchiveRestore size={15} aria-hidden="true" />}
          label="Unarchive research"
          onSelect={() => {
            onClose();
            onRestore(tree.id);
          }}
        />
      ) : null}
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
          <button className="control-button primary" type="submit" disabled={busy}>
            {busy ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

interface ResearchTreeDeleteOfferProps {
  tree: ResearchTreeSummary;
  contents: ResearchTreeContents;
  onKeep: () => void;
  onDelete: () => void;
}

/** Shown after "Ask as a question" created a new thread from the text of
 * `tree`'s root post or document: offers to delete `tree`, stating what
 * deleting it also deletes. Keep (focused first; also Escape) closes it;
 * Delete… closes it and hands over to the delete confirmation, which does
 * the deletion. Delete… is disabled while the thread has active runs. */
export function ResearchTreeDeleteOfferDialog({
  fallbackFocus,
  ...props
}: ResearchTreeDeleteOfferProps & {
  /** Where focus goes on Keep when the control focused before the dialog
   * opened is gone. */
  fallbackFocus?: () => HTMLElement | null | undefined;
}) {
  useResearchDialogReturnFocus(true, fallbackFocus);
  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onKeep();
        }
      }}
    >
      <ResearchTreeDeleteOfferPanel {...props} />
    </div>,
    document.body,
  );
}

/** The dialog element of ResearchTreeDeleteOfferDialog, without its
 * backdrop and portal. */
export function ResearchTreeDeleteOfferPanel({ tree, contents, onKeep, onDelete }: ResearchTreeDeleteOfferProps) {
  const running = tree.runningCount > 0;
  return (
    <div
      className="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-original-research-dialog-title"
      aria-describedby="delete-original-research-dialog-origin delete-original-research-dialog-contents"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onKeep();
          return;
        }
        trapResearchDialogTab(event);
      }}
    >
      <h2 id="delete-original-research-dialog-title">Delete the original thread?</h2>
      <p id="delete-original-research-dialog-origin">
        The question was asked in a new thread. The original thread, “{tree.title}”, is unchanged.
      </p>
      <p id="delete-original-research-dialog-contents">{researchTreeContentsSentence(contents)}</p>
      {running ? (
        <p>It has active runs, which must finish or be cancelled before it can be deleted.</p>
      ) : null}
      <div className="confirm-dialog-actions">
        <button className="control-button" type="button" autoFocus onClick={onKeep}>
          Keep
        </button>
        <button
          type="button"
          className="control-button danger"
          disabled={running}
          title={running ? "Research with active runs cannot be deleted" : undefined}
          onClick={onDelete}
        >
          Delete…
        </button>
      </div>
    </div>
  );
}

export function ResearchTreeDeleteDialog({
  tree,
  onClose,
  onRemove,
  fallbackFocus,
}: {
  tree: ResearchTreeSummary;
  onClose: () => void;
  onRemove: (treeId: string) => Promise<void>;
  /** Where focus goes on close when the control focused before the dialog
   * opened is gone. */
  fallbackFocus?: () => HTMLElement | null | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResearchDialogReturnFocus(true, fallbackFocus);
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
