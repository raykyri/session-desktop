// The follow-up box at the top of a note's follow-ups column
// (`09-research-document-view.md` §3), ported from the desktop
// `ResearchPostFollowUpField.tsx`. One line until focused or filled; then an
// Ask / Add a note switch and Send appear under the text. Ask runs a model
// with the note as context (the model and effort picker chooses which);
// "Add a note" adds a follow-up note, which the agent does not see. The send
// shortcut is ⌘↵ (Ctrl+↵ outside macOS). Images go with an AI follow-up;
// notes cannot include them.

import type { ModelInfo, ResearchImageAttachment } from "@session/shared";
import { composerTextareaHeight } from "@session/shared";
import { ArrowRight, LoaderCircle, StickyNote } from "lucide-react";
import { useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, Ref } from "react";

import { cn } from "../../lib/cn.js";
import { isApplePlatform } from "../../lib/platform.js";
import { ComposerSubmitShortcutGlyph } from "../../ui/ComposerSubmitShortcut.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import {
  ModelIcon,
  QuestionModelPicker,
  type ModelChoice,
} from "../composer/QuestionModelPicker.js";
import { ImageStrip, useImageInput } from "../composer/images.js";

import type { ComposerHandle } from "./ConversationComposer.js";

export type AskMode = "ai" | "note";

/** The placeholder and send button name for a mode. */
export function postFollowUpCopy(asNote: boolean): { placeholder: string; sendName: string } {
  return asNote
    ? { placeholder: "Add a note (not visible to agent)", sendName: "Add note" }
    : { placeholder: "Ask a follow-up", sendName: "Ask" };
}

export function PostFollowUpField({
  models,
  defaultChoice,
  composerRef,
  onSubmit,
}: {
  models: readonly ModelInfo[];
  /** The model a follow-up runs on until the picker chooses another. */
  defaultChoice: ModelChoice | null;
  composerRef?: Ref<ComposerHandle>;
  onSubmit: (input: {
    prompt: string;
    asNote: boolean;
    images: ResearchImageAttachment[];
    choice: ModelChoice | null;
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ResearchImageAttachment[]>([]);
  const [mode, setMode] = useState<AskMode>("ai");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [chosen, setChosen] = useState<ModelChoice | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const asNote = mode === "note";
  const choice = chosen ?? defaultChoice;
  const imageInput = useImageInput({
    images,
    onImagesChange: asNote ? undefined : (update) => setImages((current) => update(current)),
    disabled: submitting,
  });
  const errorId = useId();
  useImperativeHandle(
    composerRef,
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
  }, [draft]);
  const expanded = focused || Boolean(draft) || submitting || images.length > 0;
  const imageBlock = asNote && images.length > 0 ? "Notes can't include images." : null;
  const problem = imageInput.error ?? imageBlock ?? error;
  const ready = Boolean(draft.trim()) && !submitting && imageInput.saving === 0 && !imageBlock;
  const copy = postFollowUpCopy(asNote);

  const submit = () => {
    const prompt = draft.trim();
    if (!prompt || !ready) return;
    setSubmitting(true);
    setError(null);
    onSubmit({ prompt, asNote, images: asNote ? [] : images, choice: asNote ? null : choice })
      .then(() => {
        setDraft("");
        setImages([]);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setSubmitting(false));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const primary = isApplePlatform() ? event.metaKey : event.ctrlKey;
    if (event.key === "Enter" && primary && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      // Esc leaves the field, which collapses again when it is empty.
      event.preventDefault();
      event.currentTarget.blur();
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    // A menu opened from the box is portaled out of it.
    if (
      next instanceof Node &&
      (wrapRef.current?.contains(next) || next.closest?.("[role='menu']"))
    ) {
      return;
    }
    setFocused(false);
  };
  const segment = (active: boolean) =>
    cn(
      "inline-flex h-6 items-center gap-1 rounded-[5px] border-0 px-2 text-xs",
      active
        ? "bg-surface-popover text-fg-strong shadow-sm"
        : "bg-transparent text-fg-muted hover:text-fg-primary",
      FOCUS_RING,
    );

  return (
    <div
      ref={wrapRef}
      className="mx-2 mt-2 mb-1 flex flex-col gap-1.5"
      data-research-composer=""
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      {...imageInput.fieldProps}
    >
      <ImageStrip
        className="px-1"
        images={images}
        saving={imageInput.saving}
        onRemove={submitting ? undefined : (id) => imageInput.remove(id)}
      />
      <form
        className={cn(
          "border-border-control bg-surface-field flex flex-col gap-1.5 rounded-lg border px-2.5 py-2",
          "focus-within:border-focus-ring focus-within:shadow-[inset_0_0_0_1px_var(--focus-ring)]",
        )}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={submitting}
          placeholder={copy.placeholder}
          aria-label="Follow-up"
          aria-describedby={problem ? errorId : undefined}
          className="research-composer-text text-fg-primary placeholder:text-fg-placeholder min-h-6 w-full resize-none border-0 bg-transparent p-0 text-base outline-none"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            imageInput.clearError();
          }}
          onKeyDown={onKeyDown}
        />
        {expanded ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <div
              className="bg-surface-fill-subtle inline-flex rounded-md p-0.5"
              role="radiogroup"
              aria-label="Follow-up kind"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!asNote}
                className={segment(!asNote)}
                onClick={() => {
                  setMode("ai");
                  setError(null);
                }}
              >
                {choice ? <ModelIcon modelId={choice.model} /> : null}
                Ask
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={asNote}
                className={segment(asNote)}
                onClick={() => {
                  setMode("note");
                  setError(null);
                }}
              >
                <StickyNote size={12} aria-hidden="true" />
                Add a note
              </button>
            </div>
            {!asNote && choice ? (
              <QuestionModelPicker
                choice={choice}
                models={models}
                disabled={submitting}
                onChange={setChosen}
              />
            ) : null}
            <button
              className={cn(
                "ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 px-2 text-sm",
                ready ? "bg-accent text-fg-on-accent" : "bg-surface-fill-medium text-fg-disabled",
                FOCUS_RING,
              )}
              type="submit"
              disabled={!ready}
              aria-label={copy.sendName}
              title={`${copy.sendName} (${isApplePlatform() ? "⌘↵" : "Ctrl+↵"})`}
            >
              {submitting ? (
                <LoaderCircle className="session-spin" size={14} aria-hidden="true" />
              ) : (
                <ArrowRight size={14} aria-hidden="true" />
              )}
              <ComposerSubmitShortcutGlyph ariaHidden />
            </button>
          </div>
        ) : null}
      </form>
      {problem ? (
        <p id={errorId} className="text-status-failed m-0 px-1 text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
