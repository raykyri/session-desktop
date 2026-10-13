import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One step of a delete confirmation: its title, body paragraphs, and the
 * confirming button. `onConfirm` rejects to keep the dialog open with the
 * message. */
interface ResearchDeleteStep {
  title: ReactNode;
  body?: ReactNode;
  label?: string;
  pendingLabel?: string;
  onConfirm: () => Promise<void> | void;
}

export interface ResearchDeleteDialogProps {
  /** The first step, which moves the item to the Trash: primary Move to
   * Trash, Cancel, and a Delete now link that opens `remove`. Omitted for
   * deletions that are always permanent; the dialog is then `remove` alone. */
  trash?: ResearchDeleteStep;
  /** The permanent deletion. Title, body and label default to "Delete
   * permanently?", "This can’t be undone." and Delete. */
  remove: Partial<Omit<ResearchDeleteStep, "onConfirm">> & Pick<ResearchDeleteStep, "onConfirm">;
  /** Why neither action is available (active runs); shown, and both
   * confirming buttons are disabled. */
  disabledReason?: string | null;
  onClose: () => void;
}

/** A delete confirmation over a scrim, centred like the other confirm
 * dialogs. Focus returns to the control that opened it, else to
 * `fallbackFocus`. */
export function ResearchDeleteDialog({
  fallbackFocus,
  ...props
}: ResearchDeleteDialogProps & { fallbackFocus?: () => HTMLElement | null | undefined }) {
  useResearchDialogReturnFocus(true, fallbackFocus);
  const [busy, setBusy] = useState(false);
  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) props.onClose();
      }}
    >
      <ResearchDeleteDialogPanel {...props} onBusyChange={setBusy} />
    </div>,
    document.body,
  );
}

/** The dialog element of ResearchDeleteDialog, without its backdrop and
 * portal. The confirming button of each step takes focus; Enter outside a
 * button confirms, Escape and Cancel close. */
export function ResearchDeleteDialogPanel({
  trash,
  remove,
  disabledReason = null,
  onClose,
  onBusyChange,
  initialStep,
}: ResearchDeleteDialogProps & {
  onBusyChange?: (busy: boolean) => void;
  /** For tests: the step to render first. */
  initialStep?: "trash" | "remove";
}) {
  const [step, setStep] = useState<"trash" | "remove">(initialStep ?? (trash ? "trash" : "remove"));
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const current: ResearchDeleteStep =
    step === "trash" && trash
      ? { label: "Move to Trash", pendingLabel: "Moving…", ...trash }
      : {
          title: "Delete permanently?",
          body: <p>This can’t be undone.</p>,
          label: "Delete",
          pendingLabel: "Deleting…",
          ...remove,
        };
  const setBusy = (next: boolean) => {
    setBusyState(next);
    onBusyChange?.(next);
  };

  async function confirm() {
    if (busy || disabledReason) return;
    setError(null);
    setBusy(true);
    try {
      await current.onConfirm();
      setBusy(false);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    // Enter on a button presses that button; anywhere else it confirms.
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      void confirm();
      return;
    }
    trapResearchDialogTab(event);
  }

  return (
    <div
      className="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={current.body ? bodyId : undefined}
      aria-busy={busy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <h2 id={titleId}>{current.title}</h2>
      {current.body ? <div id={bodyId} className="confirm-dialog-body">{current.body}</div> : null}
      {disabledReason ? <p role="status">{disabledReason}</p> : null}
      {error ? (
        <p className="confirm-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      {/* Keyed by step: the new step's buttons mount and take focus. */}
      <div key={step} className="confirm-dialog-actions">
        {step === "trash" ? (
          <button
            type="button"
            className="confirm-dialog-link"
            disabled={busy}
            onClick={() => {
              setError(null);
              setStep("remove");
            }}
          >
            Delete now
          </button>
        ) : null}
        <button
          className="control-button"
          type="button"
          autoFocus={disabledReason !== null}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`control-button ${step === "trash" ? "primary" : "danger"}`}
          autoFocus={disabledReason === null}
          disabled={busy || disabledReason !== null}
          onClick={() => void confirm()}
        >
          {busy ? current.pendingLabel : current.label}
        </button>
      </div>
    </div>
  );
}
