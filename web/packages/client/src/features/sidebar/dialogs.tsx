// The sidebar's dialogs (`ResearchFolderDialog.tsx`, the rename and delete
// dialogs inside `ResearchSidebarSection.tsx`), on the shared `Dialog` wrapper.
//
// Base UI owns focus trapping, scroll locking and nested dismissal, so these
// are the copy and the one field each — the desktop's hand-built backdrops,
// `showModal()` calls and Escape handlers are gone (08 §4, ADR-9).

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "../../lib/toast.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { Input } from "../../ui/Field.js";
import { CONTROL_BUTTON } from "../../ui/surfaces.js";

/** A dialog whose whole content is one text field and a confirming action:
 * create a folder, rename a folder, rename a thread, name a workspace. */
export function NameDialog({
  open,
  title,
  description,
  label,
  initialValue = "",
  confirmLabel = "Save",
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A reopened dialog starts from the value it was opened with, not from what
  // the last edit left behind.
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) setValue(initialValue);
  }

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);

  const trimmed = value.trim();
  const submit = () => {
    if (!trimmed) return;
    onOpenChange(false);
    onSubmit(trimmed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      {...(description === undefined ? {} : { description })}
      footer={
        <>
          <BaseDialog.Close className={CONTROL_BUTTON}>Cancel</BaseDialog.Close>
          <ConfirmDialogActionButton disabled={trimmed === ""} onClick={submit}>
            {confirmLabel}
          </ConfirmDialogActionButton>
        </>
      }
    >
      <Input
        ref={inputRef}
        aria-label={label}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          submit();
        }}
        className="w-full"
      />
    </Dialog>
  );
}

/**
 * A confirmation whose action can be refused by the server. The dialog stays
 * open on failure with the reason beside the button, which is the only way the
 * user can tell a refusal ("this workspace still has runs") from a no-op.
 */
export function AsyncConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pendingLabel = "Working…",
  tone = "danger",
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  pendingLabel?: string;
  tone?: "default" | "danger";
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) setError(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
      title={title}
      {...(description === undefined ? {} : { description })}
      footer={
        <>
          <BaseDialog.Close className={CONTROL_BUTTON} disabled={pending}>
            Cancel
          </BaseDialog.Close>
          <ConfirmDialogActionButton
            tone={tone}
            pending={pending}
            pendingLabel={pendingLabel}
            onClick={() => {
              if (pending) return;
              setError(null);
              setPending(true);
              onConfirm()
                .then(() => onOpenChange(false))
                .catch((failure: unknown) => setError(errorMessage(failure)))
                .finally(() => setPending(false));
            }}
          >
            {confirmLabel}
          </ConfirmDialogActionButton>
        </>
      }
    >
      {error ? (
        <p className="text-status-failed m-0 text-base" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
