import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

import { FORM_FIELD, INPUT_FIELD, SHORTCUT_HINT } from "./surfaces.js";

export interface FieldProps {
  label: ReactNode;
  /** Explanatory line under the control. */
  hint?: ReactNode;
  /** Validation message; replaces the hint and colors the row. */
  error?: ReactNode;
  className?: string;
  children: (props: { id: string; describedBy: string | undefined }) => ReactNode;
}

/** Label, control, and one line of hint or error. The control is a render
 * callback so the ids stay wired without cloning children. */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-fg-secondary text-sm">
        {label}
      </label>
      {children({ id, describedBy: message ? messageId : undefined })}
      {message ? (
        <p
          id={messageId}
          className={cn("m-0 text-xs", error ? "text-status-failed" : "text-fg-muted")}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ ref, className, type = "text", ...props }: InputProps) {
  return <input {...props} ref={ref} type={type} className={cn(INPUT_FIELD, className)} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ ref, className, ...props }: TextareaProps) {
  return <textarea {...props} ref={ref} className={cn(FORM_FIELD, "py-2", className)} />;
}

export interface ShortcutHintProps {
  /** A rendered chord, e.g. `⇧⌘H`. Formatting belongs to the caller: the
   * shared shortcut table already owns the labels. */
  children: ReactNode;
  className?: string;
}

/** The dim chord badge the sidebar shows while Cmd is held. */
export function ShortcutHint({ children, className }: ShortcutHintProps) {
  return <span className={cn(SHORTCUT_HINT, className)}>{children}</span>;
}
