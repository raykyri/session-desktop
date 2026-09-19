import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref, RefObject } from "react";
import { useRef } from "react";

import { cn } from "../lib/cn.js";

import { ControlButton } from "./Button.js";
import { CONTROL_BUTTON, CONTROL_BUTTON_SIZE, DIALOG_BACKDROP, DIALOG_POPUP } from "./surfaces.js";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Right-aligned action row. Render `ConfirmDialogActionButton` here for
   * anything that awaits. */
  footer?: ReactNode;
  className?: string;
  /** `trap-focus` keeps the page scrollable behind the dialog; used by the
   * panels that sit beside live content. */
  modal?: boolean | "trap-focus";
  /** The element focused on open instead of the first tabbable one. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
}

/**
 * The app's one dialog shape (08 §4). Base UI owns focus trapping, scroll
 * locking, portalling, and — the reason the desktop's hand-ordered Escape
 * dispatcher goes away — nested dismissal, so a menu inside a dialog closes
 * before the dialog does.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  modal = true,
  initialFocus,
}: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={DIALOG_BACKDROP} />
        <BaseDialog.Popup
          className={cn(DIALOG_POPUP, className)}
          {...(initialFocus === undefined ? {} : { initialFocus })}
        >
          <BaseDialog.Title className="text-fg-heading text-input m-0 font-semibold">
            {title}
          </BaseDialog.Title>
          {description ? (
            <BaseDialog.Description className="text-fg-secondary mt-2 mb-0 text-base">
              {description}
            </BaseDialog.Description>
          ) : null}
          {children ? <div className="mt-4">{children}</div> : null}
          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export interface ConfirmDialogActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  pending?: boolean;
  pendingLabel?: ReactNode;
  tone?: "default" | "danger";
}

/**
 * A confirm action that stays mounted and visibly busy while its work runs,
 * ported from the desktop `ConfirmDialogActionButton.tsx`. Swapping the button
 * for a spinner would move focus and let a second Enter fall through to
 * whatever landed underneath; keeping it mounted and disabled does not.
 */
export function ConfirmDialogActionButton({
  ref,
  pending = false,
  pendingLabel = "Working…",
  tone = "default",
  disabled,
  children,
  className,
  type = "button",
  ...props
}: ConfirmDialogActionButtonProps) {
  return (
    <ControlButton
      {...props}
      ref={ref}
      type={type}
      tone={tone}
      className={cn("gap-2", className)}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
    >
      {pending ? (
        <>
          <LoaderCircle className="session-spin" size={14} aria-hidden="true" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </ControlButton>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  pendingLabel?: string;
  tone?: "default" | "danger";
  /** The confirm action is unavailable for a reason the description states. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

/** Title, prose, Cancel, and one confirming action. A destructive dialog
 * opens with the action focused, so Enter confirms and Escape cancels. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  pending = false,
  pendingLabel,
  tone = "default",
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      {...(description === undefined ? {} : { description })}
      {...(tone === "danger" ? { initialFocus: confirmRef } : {})}
      footer={
        <>
          <BaseDialog.Close
            className={cn(CONTROL_BUTTON, CONTROL_BUTTON_SIZE.md)}
            disabled={pending}
          >
            {cancelLabel}
          </BaseDialog.Close>
          <ConfirmDialogActionButton
            ref={confirmRef}
            pending={pending}
            tone={tone}
            disabled={confirmDisabled}
            {...(pendingLabel === undefined ? {} : { pendingLabel })}
            onClick={onConfirm}
          >
            {confirmLabel}
          </ConfirmDialogActionButton>
        </>
      }
    />
  );
}
