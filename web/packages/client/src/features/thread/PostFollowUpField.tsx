// The follow-up box at the top of a note's follow-ups column
// (`09-research-document-view.md` §3), ported from the desktop
// `ResearchPostFollowUpField.tsx`. One line until focused or filled; then the
// Ask/Note switch (`composer/AskNoteSwitch`, as in the Home ask box) and Send
// appear under the text. Ask runs a model with the note as context; a press on
// the selected Ask segment opens the model menu (model and effort). "Add a
// note" adds a follow-up note, which the agent does not see. The send
// shortcut follows the "Require ⌘↵ to send" setting. Images go with an AI
// follow-up; notes cannot include them.

import type { ModelInfo, ResearchImageAttachment } from "@session/shared";
import { composerTextareaHeight, findModel } from "@session/shared";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, Ref } from "react";

import { cn } from "../../lib/cn.js";
import { RESEARCH_NOTE_IMAGE_ERROR } from "../../lib/researchImages.js";
import { AnchoredMenu } from "../../ui/AnchoredMenu.js";
import {
  ComposerSubmitShortcutGlyph,
  composerSendChord,
  isComposerSubmitShortcut,
  useRequireCmdEnterToSend,
} from "../../ui/ComposerSubmitShortcut.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { AskNoteSwitch, type AskMode } from "../composer/AskNoteSwitch.js";
import { ModelIcon, ModelMenuItems, type ModelChoice } from "../composer/QuestionModelPicker.js";
import { ImageStrip, useImageInput } from "../composer/images.js";

import type { ComposerHandle } from "./ConversationComposer.js";

export type { AskMode };

/** The box's placeholder and send button name and tooltip for a mode, as on
 * the desktop. `askLabel` ("Ask {model}") is the send tooltip in Ask. */
export function postFollowUpCopy(
  asNote: boolean,
  askLabel = "Ask AI",
): { placeholder: string; sendName: string; sendTitle: string } {
  return asNote
    ? {
        placeholder: "Add a note (not visible to agent)",
        sendName: "Add note",
        sendTitle: "Add note",
      }
    : { placeholder: "Ask a follow-up", sendName: "Ask", sendTitle: askLabel };
}

/** The Ask segment's name and tooltip: "Ask" and the model, as the desktop's
 * "Ask {agent} {model}" (the web's models carry their family in the label);
 * "Ask AI" with no model. */
export function postFollowUpAskLabel(
  models: readonly ModelInfo[],
  choice: ModelChoice | null,
): string {
  if (!choice) return "Ask AI";
  const label =
    models.find((model) => model.id === choice.model)?.label ??
    findModel(choice.model)?.label ??
    choice.model;
  return `Ask ${label}`;
}

export function PostFollowUpField({
  models,
  defaultChoice,
  composerRef,
  onSubmit,
}: {
  models: readonly ModelInfo[];
  /** The model a follow-up runs on until the model menu chooses another. */
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
  // The model menu, open below the Ask segment.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const requireCmdEnter = useRequireCmdEnterToSend();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const askSegmentRef = useRef<HTMLButtonElement | null>(null);
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
  // The model menu belongs to the expanded row in Ask; leaving the box or
  // switching to Note closes it, so it never reopens by itself.
  const menuOpen = menuAnchor !== null && expanded && !asNote;
  const setMenuOpen = (open: boolean) => setMenuAnchor(open ? askSegmentRef.current : null);
  const imageBlock = asNote && images.length > 0 ? RESEARCH_NOTE_IMAGE_ERROR : null;
  const problem = imageInput.error ?? imageBlock ?? error;
  const ready = Boolean(draft.trim()) && !submitting && imageInput.saving === 0 && !imageBlock;
  const askLabel = postFollowUpAskLabel(models, choice);
  const copy = postFollowUpCopy(asNote, askLabel);

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
    if (isComposerSubmitShortcut(event, undefined, requireCmdEnter)) {
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
    // The model menu is portaled out of the box.
    if (
      next instanceof Node &&
      (wrapRef.current?.contains(next) || next.closest?.("[role='menu']"))
    ) {
      return;
    }
    setFocused(false);
    setMenuAnchor(null);
  };

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
            <AskNoteSwitch
              askMode={mode}
              askIcon={
                choice ? (
                  <ModelIcon modelId={choice.model} size={13} />
                ) : (
                  <Sparkles size={13} aria-hidden="true" />
                )
              }
              askLabel={askLabel}
              noteLabel="Add a note"
              menuOpen={menuOpen}
              askRef={askSegmentRef}
              onModeChange={(next) => {
                setMode(next);
                setMenuOpen(false);
                setError(null);
              }}
              // No menu while no model is listed.
              {...(choice ? { onMenuOpenChange: setMenuOpen } : {})}
            />
            <button
              className={cn(
                "ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 px-2 text-sm",
                ready ? "bg-accent text-fg-on-accent" : "bg-surface-fill-medium text-fg-disabled",
                FOCUS_RING,
              )}
              type="submit"
              disabled={!ready}
              aria-label={copy.sendName}
              title={`${copy.sendTitle} (${composerSendChord(requireCmdEnter)})`}
            >
              {submitting ? (
                <LoaderCircle className="session-spin" size={14} aria-hidden="true" />
              ) : (
                <ArrowRight size={14} aria-hidden="true" />
              )}
              <ComposerSubmitShortcutGlyph requireCmdEnter={requireCmdEnter} ariaHidden />
            </button>
          </div>
        ) : null}
      </form>
      {menuOpen && menuAnchor && choice ? (
        <AnchoredMenu anchor={menuAnchor} label="Model" onClose={() => setMenuOpen(false)}>
          <ModelMenuItems
            models={models}
            model={choice.model}
            effort={choice.effort ?? ""}
            onModel={(model) => {
              setChosen({ model, effort: null });
              setError(null);
            }}
            onEffort={(effort) =>
              setChosen({
                model: choice.model,
                effort: effort === "" ? null : (effort as ModelChoice["effort"]),
              })
            }
          />
        </AnchoredMenu>
      ) : null}
      {problem ? (
        <p id={errorId} className="text-status-failed m-0 px-1 text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
