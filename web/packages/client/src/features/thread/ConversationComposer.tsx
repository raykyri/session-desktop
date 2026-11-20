// A column's ask box (`09-research-document-view.md` §6), ported from the
// desktop `ResearchConversationComposer.tsx`. One sits after the messages of
// each chain a column shows (a level's messages column, the selected group of
// a branches column, an unsent branch); it scrolls with them. ⌘↵ (Ctrl+↵
// outside macOS) sends, ↵ adds a line, and ⇧⌘↵ starts a branch from the
// chain's last finished answer instead of continuing it. A mode label ("New
// branch", "Editing …") sits above the field with a × that Esc also
// triggers. Images pasted or dropped on the box are attached; the model and
// effort picker chooses what the question runs on.

import { composerTextareaHeight } from "@session/shared";
import type { ResearchImageAttachment, ModelInfo } from "@session/shared";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { isApplePlatform } from "../../lib/platform.js";
import { ComposerSubmitShortcutGlyph } from "../../ui/ComposerSubmitShortcut.js";
import { FOCUS_RING, SHORTCUT_HINT } from "../../ui/surfaces.js";
import { QuestionModelPicker, type ModelChoice } from "../composer/QuestionModelPicker.js";
import { ImageStrip, useImageInput, type ImagesUpdate } from "../composer/images.js";

const NO_IMAGES: readonly ResearchImageAttachment[] = [];

export interface ComposerHandle {
  focus: () => void;
  element: () => HTMLElement | null;
}

/** What an Enter key press in an ask box does: ⇧⌘↵ branches, ⌘↵ sends,
 * anything else is the field's (null). Ctrl stands for ⌘ outside macOS. */
export function composerEnterAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey"> & {
    nativeEvent: { isComposing: boolean };
  },
  apple: boolean = isApplePlatform(),
): "branch" | "send" | null {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return null;
  const primary = apple ? event.metaKey : event.ctrlKey;
  if (!primary) return null;
  return event.shiftKey ? "branch" : "send";
}

export const ConversationComposer = forwardRef<
  ComposerHandle,
  {
    value: string;
    placeholder: string;
    disabled: boolean;
    canSubmit: boolean;
    submitting: boolean;
    /** Shown above the field (a stalled tail, an archived question). */
    note?: ReactNode;
    /** The box's mode, above the field. */
    mode?: { label: ReactNode; cancelLabel?: string; onCancel?: () => void } | null;
    ariaLabel?: string;
    /** The attached images; with `onImagesChange`, the box accepts more. */
    images?: readonly ResearchImageAttachment[];
    onImagesChange?: ImagesUpdate;
    /** Why the attached images cannot be sent with the chosen model (it
     * can't read images, or they total more than a message carries); Send
     * stays disabled while there are images. */
    imageBlockReason?: string | null;
    /** The model and effort the question runs on, and the models to pick
     * from; without them the box has no picker. */
    model?: {
      choice: ModelChoice;
      models: readonly ModelInfo[];
      onChange: (choice: ModelChoice) => void;
    } | null;
    /** The label of the send button ("Send", "Queue"). */
    sendLabel?: string;
    /** The ⌘J hint, shown in the current column's box while ⌘ is held
     * (`lib/shortcutHints`). */
    shortcutHint?: string | null;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onSubmitBranch?: () => void;
  }
>(function ConversationComposer(
  {
    value,
    placeholder,
    disabled,
    canSubmit,
    submitting,
    note,
    mode = null,
    ariaLabel = "Ask a follow-up",
    images = NO_IMAGES,
    onImagesChange,
    imageBlockReason = null,
    model = null,
    sendLabel = "Send",
    shortcutHint = null,
    onChange,
    onSubmit,
    onSubmitBranch,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useImageInput({ images, onImagesChange, disabled });
  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus({ preventScroll: true }),
      element: () => wrapRef.current,
    }),
    [],
  );
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${composerTextareaHeight(textarea.scrollHeight)}px`;
  }, [value]);
  const imageBlock = images.length > 0 ? imageBlockReason : null;
  const imageProblem = imageInput.error ?? imageBlock;
  // Send stays disabled while images are still saving or cannot be sent with
  // the chosen model.
  const imagesReady = imageInput.saving === 0 && !imageBlock;
  const ready = canSubmit && value.trim().length > 0 && imagesReady;
  const noteId = useId();
  const errorId = useId();
  const describedBy = [note ? noteId : null, imageProblem ? errorId : null]
    .filter(Boolean)
    .join(" ");
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && mode?.onCancel && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      mode.onCancel();
      return;
    }
    const action = composerEnterAction(event);
    if (action === null) return;
    event.preventDefault();
    if (action === "branch") {
      if (value.trim() && onSubmitBranch && imagesReady) onSubmitBranch();
    } else if (ready && !submitting) {
      onSubmit();
    }
  };
  return (
    <div
      ref={wrapRef}
      className="research-composer-wrap mx-2 mt-1.5 mb-3 flex flex-col gap-1.5"
      data-research-composer=""
      {...imageInput.fieldProps}
    >
      {mode ? (
        <div className="text-fg-muted flex items-center gap-1.5 px-1 text-[length:calc(12.5px+var(--font-ui-size-offset))]">
          <span className="[&_b]:text-fg-secondary min-w-0 flex-1 [&_b]:font-semibold">
            {mode.label}
          </span>
          {mode.onCancel ? (
            <button
              type="button"
              className={cn(
                "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-strong flex size-6 shrink-0 items-center justify-center rounded-md",
                FOCUS_RING,
              )}
              aria-label={mode.cancelLabel ?? "Cancel"}
              title={mode.cancelLabel ? `${mode.cancelLabel} (Esc)` : "Cancel (Esc)"}
              onClick={mode.onCancel}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <div
          id={noteId}
          className="text-fg-muted px-1 text-[length:calc(12.5px+var(--font-ui-size-offset))]"
        >
          {note}
        </div>
      ) : null}
      <ImageStrip
        className="px-1"
        images={images}
        saving={imageInput.saving}
        onRemove={
          onImagesChange && !disabled
            ? (id) => {
                imageInput.remove(id);
                textareaRef.current?.focus({ preventScroll: true });
              }
            : undefined
        }
      />
      <form
        className={cn(
          "border-border-control bg-surface-field relative flex flex-col gap-1 rounded-lg border px-2.5 pt-2 pb-1.5",
          "focus-within:border-focus-ring focus-within:shadow-[inset_0_0_0_1px_var(--focus-ring)]",
          disabled && "opacity-60",
        )}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !submitting) onSubmit();
        }}
      >
        {shortcutHint ? (
          <span className={cn(SHORTCUT_HINT, "absolute top-2.5 right-2.5")} aria-hidden="true">
            {shortcutHint}
          </span>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-describedby={describedBy || undefined}
          disabled={disabled}
          className="research-composer-text text-fg-primary placeholder:text-fg-placeholder min-h-6 w-full resize-none border-0 bg-transparent p-0 text-base outline-none"
          onChange={(event) => {
            imageInput.clearError();
            onChange(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            {model ? (
              <QuestionModelPicker
                choice={model.choice}
                models={model.models}
                disabled={disabled}
                onChange={model.onChange}
              />
            ) : null}
          </div>
          <button
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 px-2 text-sm",
              ready && !submitting
                ? "bg-accent text-fg-on-accent"
                : "bg-surface-fill-medium text-fg-disabled",
              FOCUS_RING,
            )}
            type="submit"
            disabled={!ready || submitting}
            aria-label={sendLabel}
            title={`${sendLabel} (${isApplePlatform() ? "⌘↵" : "Ctrl+↵"})`}
          >
            {submitting ? (
              <LoaderCircle className="session-spin" size={14} aria-hidden="true" />
            ) : (
              <ArrowRight size={14} aria-hidden="true" />
            )}
            <span className="sr-only">{sendLabel}</span>
            <ComposerSubmitShortcutGlyph ariaHidden />
          </button>
        </div>
      </form>
      {imageProblem ? (
        <p id={errorId} className="text-status-failed m-0 px-1 text-sm" role="alert">
          {imageProblem}
        </p>
      ) : null}
    </div>
  );
});
