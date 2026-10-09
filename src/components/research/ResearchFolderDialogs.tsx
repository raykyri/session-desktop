import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ResearchFolder } from "../../types";
import { normalizeResearchFolderName, researchFolderNameError } from "../../lib/researchFolders";
import { researchFeedCardControl } from "./ResearchFeedPost";

/** `returnFocus` is the button that opened the dialog, often through a menu
 * that is gone by the time the dialog closes. */
export type ResearchFolderNameRequest = (
  | { kind: "create"; moveTreeId?: string | null }
  | { kind: "rename"; folderId: string; name: string }
) & { returnFocus?: HTMLElement | null };

/** New folder / Rename folder: a small modal over the window with the name
 * field focused. Enter or the primary button confirms; Esc, Cancel, or a
 * click outside closes it. Problems show inline and keep the text. */
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
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<Element | null>(
    request.returnFocus ?? (typeof document === "undefined" ? null : document.activeElement),
  );
  const id = useId();
  const titleId = `${id}-title`;
  const inputId = `${id}-name`;
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

  function trapFocus(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []),
    ];
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
      event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
    }
  }

  return createPortal(
    <div className="research-folder-dialog-layer">
      <div className="research-folder-dialog-scrim" onMouseDown={onClose} />
      <form
        ref={dialogRef}
        className={`research-folder-dialog${value.trim() ? " is-ready" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        noValidate
        onKeyDown={trapFocus}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3 id={titleId}>{title}</h3>
        {moving ? (
          <p className="research-folder-dialog-sub">The question moves into it once it's created.</p>
        ) : null}
        <label className="research-visually-hidden" htmlFor={inputId}>
          Folder name
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="research-folder-dialog-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="Folder name"
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
        />
        <div id={errorId} className="research-feed-error" role="alert" hidden={!error}>
          {error}
        </div>
        <div className="research-folder-dialog-row">
          <span className="research-feed-header-spacer" />
          <button type="button" className="research-feed-button is-tint" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="research-feed-button is-primary" disabled={busy}>
            {submitLabel}
            <span className="research-feed-enter" aria-hidden="true">↵</span>
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Confirms deleting a folder under the folder view's header. Cancel takes
 * focus when it opens; Esc cancels, and goes no further. `count` includes
 * archived questions, which leave the folder too. */
export function ResearchFolderDeleteConfirm({
  name,
  count,
  onConfirm,
  onCancel,
}: {
  name: string;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return (
    <div className="research-folder-confirm" role="alertdialog" aria-label="Delete folder">
      <div>
        Delete “{name}”?{" "}
        {count > 0
          ? `Its ${count} question${count === 1 ? "" : "s"} move${count === 1 ? "s" : ""} to Unfiled.`
          : "It is empty."}
      </div>
      <div className="research-folder-confirm-row">
        <button type="button" className="research-feed-button is-danger" onClick={onConfirm}>
          Delete folder
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="research-feed-button is-ghost"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
