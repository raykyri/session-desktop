import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ResearchFolder } from "../../types";
import { normalizeResearchFolderName, researchFolderNameError } from "@session/shared/lib/researchFolders";
import { researchFeedCardControl } from "./ResearchFeedCard";
import { researchTrashFolderSentence } from "@session/shared/lib/researchTrash";
import { ResearchDeleteDialog, type ResearchDeleteDialogProps } from "./ResearchDeleteDialog";
import { trapResearchDialogTab } from "./researchFocus";

/** `returnFocus` is the button that opened the dialog, often through a menu
 * that is gone by the time the dialog closes. */
export type ResearchFolderNameRequest = (
  | { kind: "create"; moveTreeId?: string | null }
  | { kind: "rename"; folderId: string; name: string }
) & { returnFocus?: HTMLElement | null };

/** New folder / Rename folder: a confirm dialog with the name field focused.
 * Enter or the primary button confirms; Esc, Cancel, or a click outside
 * closes it. Errors show inline, and the typed name is kept. */
export function ResearchFolderNameDialog({
  request,
  folders,
  onSubmit,
  onClose,
}: {
  request: ResearchFolderNameRequest;
  folders: ResearchFolder[];
  onSubmit: (name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(request.kind === "rename" ? request.name : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<Element | null>(
    request.returnFocus ?? (typeof document === "undefined" ? null : document.activeElement),
  );
  const id = useId();
  const titleId = `${id}-title`;
  const errorId = `${id}-error`;

  // A card's … button is gone once Create and move has moved the card into
  // the new folder; focus then goes to the card's … button there.
  const movedTreeId = request.kind === "create" ? (request.moveTreeId ?? null) : null;
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const returnFocus = returnFocusRef.current;
    return () => {
      const target =
        returnFocus instanceof HTMLElement && returnFocus.isConnected
          ? returnFocus
          : movedTreeId
            ? (researchFeedCardControl(movedTreeId, "menu") ??
              document.querySelector<HTMLElement>(".research-feed-header-title"))
            : null;
      target?.focus({ preventScroll: true });
    };
  }, [movedTreeId]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        noValidate
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          trapResearchDialogTab(event);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {moving ? <p>The question moves into it once it's created.</p> : null}
        <input
          ref={inputRef}
          className="rename-dialog-input"
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
          <p id={errorId} className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="control-button primary" type="submit" disabled={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

interface ResearchFolderDeleteProps {
  name: string;
  /** Includes archived questions, which leave the folder too. */
  count: number;
  /** Moves the folder to the Trash (the default). */
  onTrash: () => Promise<void> | void;
  /** Deletes it now; its questions move to Unfiled. */
  onDelete: () => Promise<void> | void;
  onCancel: () => void;
}

/** The folder delete confirmation's steps, for ResearchDeleteDialog and its
 * panel. */
export function researchFolderDeleteDialogProps({
  name,
  count,
  onTrash,
  onDelete,
  onCancel,
}: ResearchFolderDeleteProps): ResearchDeleteDialogProps {
  return {
    trash: {
      title: `Delete “${name}”?`,
      body: <p>{researchTrashFolderSentence(count)}</p>,
      onConfirm: onTrash,
    },
    remove: {
      body: (
        <p>
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

/** Confirms deleting a folder: Move to Trash, or Delete now. Focus returns to
 * the control that opened it, else to `fallbackFocus`. */
export function ResearchFolderDeleteDialog({
  fallbackFocus,
  ...props
}: ResearchFolderDeleteProps & { fallbackFocus?: () => HTMLElement | null | undefined }) {
  return (
    <ResearchDeleteDialog {...researchFolderDeleteDialogProps(props)} fallbackFocus={fallbackFocus} />
  );
}

