// The feed's ask box (the desktop's `ResearchQueryComposer.tsx`): a one-line
// "Ask a question" field that grows when it has focus or text and then shows
// a row under it with the Ask/Note switch and the send button. The selected
// Ask segment opens the model menu (registry models, with Effort as a
// submenu). Once there is text, a … button before Send opens Save draft.
// Images are pasted or dropped onto the box. ⌘↵ (Ctrl↵ elsewhere) sends; a
// note whose text is one URL is saved as a link.
//
// The text, images, model and effort are kept per workspace in the drafts
// store (sessionStorage and the server's interface drafts), so a reload or
// another device finds them.

import type { ResearchImageAttachment, ResearchTreeDetail } from "@session/shared";
import { DEFAULT_MODEL_ID, MAX_POST_TEXT_BYTES } from "@session/shared";
import { launcherTabAction } from "@session/shared/lib/launcherKeyboard";
import { postFormatOf } from "@session/shared/lib/researchNodeTypes";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, FilePen, LoaderCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  useCreateResearchPost,
  useCreateResearchTree,
  useMe,
  useRuntimeConfig,
  useSaveResearchDraft,
} from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { RESEARCH_NOTE_IMAGE_ERROR, researchImageBlockReason } from "../../lib/researchImages.js";
import { errorMessage, pushToast } from "../../lib/toast.js";
import { homeDraftKey, markDraftEdited, useDraftsStore } from "../../stores/drafts.js";
import { useHomeFocusStore } from "../../stores/homeFocus.js";
import { useSettingsStore } from "../../stores/settings.js";
import { AnchoredMenu } from "../../ui/AnchoredMenu.js";
import {
  composerSendChord,
  isComposerSubmitShortcut,
  useRequireCmdEnterToSend,
} from "../../ui/ComposerSubmitShortcut.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { IconMenuItem } from "../sidebar/menuRows.js";

import { AskNoteSwitch, type AskMode } from "./AskNoteSwitch.js";
import {
  askLabelFor,
  composerModels,
  ModelIcon,
  ModelMenuItems,
  nextComposerModel,
  resolvedEffort,
} from "./QuestionModelPicker.js";
import { ImageStrip, useImageInput } from "./images.js";
import { oversizeRefusal } from "./limits.js";
import { useRemoteComposerDraft } from "./useRemoteComposerDraft.js";

export { composerModels, launchableModels, nextComposerModel } from "./QuestionModelPicker.js";

/** The Home ask box's placeholder and send button name for a mode. In Note
 * mode a body that is a single URL is saved as a link. */
export function askBoxCopy(
  askMode: AskMode,
  prompt: string,
  submitting: boolean,
  askPlaceholder: string,
): { placeholder: string; submitLabel: string } {
  if (askMode === "note") {
    return {
      placeholder: "Write or paste a link",
      submitLabel: submitting
        ? "Saving…"
        : postFormatOf(prompt) === "link"
          ? "Save link"
          : "Save note",
    };
  }
  return {
    placeholder: askPlaceholder,
    submitLabel: submitting ? "Starting research…" : "Start research",
  };
}

/** Focus inside the composer, or in the menus it opens (portals). */
function insideComposer(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  if (root?.contains(target)) return true;
  return target instanceof Element && target.closest("[role='menu']") !== null;
}

const UTF8 = new TextEncoder();

export function ResearchQueryComposer({
  workspaceId,
  placeholder = "Ask a question",
  onCreated,
  homeFocus = false,
}: {
  workspaceId: string;
  placeholder?: string;
  /** Home's box: it takes the focus Shift-Cmd-H requests
   * (`stores/homeFocus`). */
  homeFocus?: boolean;
  /** A new thread was created from the box (a question, or a note), before
   * a question opens; a folder view files it there. */
  onCreated?: (detail: ResearchTreeDetail) => void;
}) {
  const navigate = useNavigate();
  const me = useMe();
  const runtimeConfig = useRuntimeConfig();
  const createTree = useCreateResearchTree();
  const createPost = useCreateResearchPost();
  const saveDraftMutation = useSaveResearchDraft();
  const defaultModel = useSettingsStore((state) => state.settings.defaultModel);

  const draftKey = homeDraftKey(workspaceId);
  const readDraft = useDraftsStore((state) => state.get);
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);

  // Seeded from the stored draft rather than restored by an effect, which
  // would paint one empty frame first.
  const [prompt, setPrompt] = useState(() => readDraft(draftKey)?.text ?? "");
  const [images, setImages] = useState<ResearchImageAttachment[]>(
    () => readDraft(draftKey)?.images ?? [],
  );
  const [model, setModel] = useState(
    () => readDraft(draftKey)?.model ?? defaultModel ?? DEFAULT_MODEL_ID,
  );
  const [effortChoice, setEffortChoice] = useState(() => readDraft(draftKey)?.effort ?? "");
  // Every new box opens on Ask; the mode is not kept with the draft.
  const [askMode, setAskMode] = useState<AskMode>("ai");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [focused, setFocused] = useState(false);
  // The model menu, open below the Ask segment.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuOpen = menuAnchor !== null;
  const setMenuOpen = (open: boolean) => setMenuAnchor(open ? askSegmentRef.current : null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const focusRequest = useHomeFocusStore((state) => (homeFocus ? state.request : 0));
  const clearFocusRequest = useHomeFocusStore((state) => state.clear);
  useEffect(() => {
    if (focusRequest === 0) return;
    promptRef.current?.focus();
    clearFocusRequest();
  }, [clearFocusRequest, focusRequest]);
  const askSegmentRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const imageProblemId = useId();
  const requireCmdEnter = useRequireCmdEnterToSend();

  useRemoteComposerDraft(draftKey, (draft) => {
    setPrompt(draft.text);
    setImages(draft.images ?? []);
    setModel(draft.model ?? defaultModel ?? DEFAULT_MODEL_ID);
    setEffortChoice(draft.effort ?? "");
  });

  const models = useMemo(
    () => composerModels(runtimeConfig.data?.models, me.data?.isAdmin === true),
    [runtimeConfig.data?.models, me.data?.isAdmin],
  );
  const selected = models.find((candidate) => candidate.id === model) ?? models[0] ?? null;
  const modelId = selected?.id ?? model;
  const effort = resolvedEffort(modelId, effortChoice);

  // Switching workspace swaps drafts rather than carrying one question into
  // another workspace (adjusted during render, as for state derived from a
  // prop).
  const [lastDraftKey, setLastDraftKey] = useState(draftKey);
  if (lastDraftKey !== draftKey) {
    setLastDraftKey(draftKey);
    const draft = readDraft(draftKey);
    setPrompt(draft?.text ?? "");
    setImages(draft?.images ?? []);
    setModel(draft?.model ?? defaultModel ?? DEFAULT_MODEL_ID);
    setEffortChoice(draft?.effort ?? "");
    setError(null);
  }

  /** Stores the box: cleared when it matches a fresh box (no text or images,
   * the default model and effort). */
  const persist = (next: {
    text: string;
    images: ResearchImageAttachment[];
    model: string;
    effort: string;
  }) => {
    markDraftEdited(draftKey);
    const fresh =
      next.text.trim() === "" &&
      next.images.length === 0 &&
      next.model === (defaultModel ?? DEFAULT_MODEL_ID) &&
      next.effort === "";
    if (fresh) {
      clearDraft(draftKey);
      return;
    }
    setDraft(draftKey, {
      text: next.text,
      model: next.model,
      ...(next.effort ? { effort: next.effort } : {}),
      ...(next.images.length > 0 ? { images: next.images } : {}),
    });
  };
  const current = { text: prompt, images, model, effort: effortChoice };

  const imageInput = useImageInput({
    images,
    disabled: submitting,
    onImagesChange: (update) => {
      setImages((previous) => {
        const next = update(previous);
        persist({ ...current, images: next });
        return next;
      });
    },
  });

  // An open menu keeps the box open: its anchor is the switch in the toolbar.
  const expanded =
    focused ||
    menuOpen ||
    moreAnchor !== null ||
    prompt !== "" ||
    images.length > 0 ||
    imageInput.saving > 0;
  // Grow the field to fit the committed value in the same pre-paint commit;
  // an empty field drops back to one line.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "";
    if (!prompt) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [expanded, prompt]);

  // Notes can't include images, and a model that can't read images blocks
  // the send rather than dropping them.
  const imageBlock =
    images.length === 0
      ? null
      : askMode === "note"
        ? RESEARCH_NOTE_IMAGE_ERROR
        : researchImageBlockReason(selected, images);
  const imageProblem = imageInput.error ?? imageBlock;

  const canSubmit =
    prompt.trim() !== "" &&
    !submitting &&
    imageInput.saving === 0 &&
    !imageBlock &&
    workspaceId !== "" &&
    (askMode === "note" || (selected !== null && selected.available));

  const collapseIfFocusLeft = () => {
    if (!insideComposer(rootRef.current, document.activeElement)) setFocused(false);
  };

  async function submit() {
    const text = prompt.trim();
    if (!text) {
      promptRef.current?.focus();
      return;
    }
    if (!canSubmit || !selected) return;
    if (askMode === "note" && UTF8.encode(text).length > MAX_POST_TEXT_BYTES) {
      setError("The note is longer than 64 KB.");
      return;
    }
    const refusal = askMode === "ai" ? oversizeRefusal(text, "question") : null;
    if (refusal) {
      setError(refusal);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (askMode === "note") {
        const detail = await createPost.mutateAsync({
          body: text,
          workspaceId,
          model: selected.id,
          effort,
        });
        onCreated?.(detail);
      } else {
        const detail = await createTree.mutateAsync({
          prompt: text,
          model: selected.id,
          effort,
          workspaceId,
          ...(images.length > 0 ? { images: images.map((image) => image.id) } : {}),
        });
        onCreated?.(detail);
        void navigate({
          to: "/r/$treeId",
          params: { treeId: detail.tree.id },
          search: { ws: workspaceId },
        });
      }
      // The text and images clear; the model and effort stay for the next
      // ask.
      setPrompt("");
      setImages([]);
      persist({ ...current, text: "", images: [] });
    } catch (failure) {
      // Shown here, where the user is looking, with every field intact for
      // the retry.
      setError(errorMessage(failure));
    } finally {
      setSubmitting(false);
    }
    requestAnimationFrame(collapseIfFocusLeft);
  }

  const canSaveDraft = prompt.trim() !== "" && imageInput.saving === 0;
  async function saveDraft() {
    const text = prompt.trim();
    if (savingDraft) return;
    if (!text) {
      setError("Write a question first.");
      promptRef.current?.focus();
      return;
    }
    setSavingDraft(true);
    try {
      await saveDraftMutation.mutateAsync({
        workspaceId,
        prompt: text,
        ...(images.length > 0 ? { images: images.map((image) => image.id) } : {}),
      });
      setPrompt("");
      setImages([]);
      setError(null);
      persist({ ...current, text: "", images: [] });
      pushToast({ title: "Saved to Drafts." });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSavingDraft(false);
    }
    requestAnimationFrame(collapseIfFocusLeft);
  }

  const { placeholder: shownPlaceholder, submitLabel } = askBoxCopy(
    askMode,
    prompt,
    submitting,
    placeholder,
  );
  const askLabel = askLabelFor(selected, effort);
  const sendShortcut = composerSendChord(requireCmdEnter);

  return (
    <div
      ref={rootRef}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!insideComposer(rootRef.current, event.relatedTarget)) {
          // A click elsewhere collapses an empty box; the menus are portals.
          requestAnimationFrame(collapseIfFocusLeft);
        }
      }}
      {...imageInput.fieldProps}
    >
      {/* The form takes ⌃Tab from its fields and puts the caret in the field
          on a press on its padding. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <form
        aria-label="New research"
        className={cn(
          "border-border-strong bg-surface-feed-field flex cursor-text flex-col rounded-[10px] border py-[7px] pr-[7px] pl-3",
          "focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]",
          menuOpen && "border-accent shadow-[0_0_0_3px_var(--accent-soft)]",
        )}
        onKeyDown={(event) => {
          // Plain Tab moves focus; ⌃Tab steps the model.
          const action = launcherTabAction(event, askMode === "ai" && models.length > 1);
          if (!action) return;
          event.preventDefault();
          event.stopPropagation();
          if (action === "cycle-model") {
            const next = nextComposerModel(models, modelId);
            setModel(next);
            persist({ ...current, model: next });
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onMouseDown={(event) => {
          // A press on the box's padding or the row's empty space puts the
          // caret in the field.
          if (event.target === event.currentTarget || event.target === rowRef.current) {
            event.preventDefault();
            promptRef.current?.focus();
          }
        }}
      >
        <ImageStrip
          images={images}
          saving={imageInput.saving}
          onRemove={
            submitting
              ? undefined
              : (id) => {
                  imageInput.remove(id);
                  promptRef.current?.focus();
                }
          }
        />
        <textarea
          ref={promptRef}
          rows={1}
          value={prompt}
          placeholder={shownPlaceholder}
          aria-label="New question"
          aria-describedby={imageProblem ? imageProblemId : undefined}
          className="text-fg-strong placeholder:text-fg-faint block max-h-40 min-h-[30px] w-full min-w-0 resize-none border-0 bg-transparent px-0 py-1 text-[length:calc(var(--fs-base)+1px)] leading-[1.45] outline-none"
          onChange={(event) => {
            const text = event.currentTarget.value;
            setPrompt(text);
            setError(null);
            imageInput.clearError();
            persist({ ...current, text });
          }}
          onKeyDown={(event) => {
            // Esc leaves the field, which collapses again when it is empty.
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.blur();
              setFocused(false);
              return;
            }
            // Enter in an empty field does nothing; Shift+Enter adds a line.
            if (event.key === "Enter" && !event.shiftKey && !prompt.trim()) {
              event.preventDefault();
              return;
            }
            if (isComposerSubmitShortcut(event, undefined, requireCmdEnter)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {expanded ? (
          <div
            ref={rowRef}
            className="mt-1 -ml-[5px] flex min-w-0 cursor-default items-center gap-1.5"
          >
            <AskNoteSwitch
              askMode={askMode}
              askIcon={<ModelIcon modelId={modelId} size={13} />}
              askLabel={askLabel}
              noteLabel="Save as note"
              menuOpen={menuOpen}
              askRef={askSegmentRef}
              onModeChange={(mode) => {
                setAskMode(mode);
                setMenuOpen(false);
                setError(null);
              }}
              onMenuOpenChange={setMenuOpen}
            />
            <div className="flex-1" />
            {canSaveDraft ? (
              <button
                type="button"
                className={cn(
                  "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary aria-expanded:bg-surface-fill-hover grid size-[30px] place-items-center rounded-md border-0 bg-transparent p-0",
                  FOCUS_RING,
                )}
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={moreAnchor !== null}
                title="More actions"
                onClick={(event) => {
                  const trigger = event.currentTarget;
                  trigger.focus();
                  setMoreAnchor((open) => (open ? null : trigger));
                }}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="submit"
              className={cn(
                "border-border-control bg-control text-fg-control hover:not-disabled:bg-control-hover disabled:text-fg-disabled grid size-[30px] place-items-center rounded-md border p-0",
                FOCUS_RING,
              )}
              disabled={!canSubmit}
              aria-label={submitLabel}
              title={`${submitLabel} (${sendShortcut})`}
            >
              {submitting ? (
                <LoaderCircle className="session-spin" size={15} aria-hidden="true" />
              ) : (
                <ArrowRight size={15} aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
        {error || imageProblem ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {imageProblem ? (
              <p id={imageProblemId} className="text-status-failed m-0 text-sm" role="alert">
                {imageProblem}
              </p>
            ) : null}
            {error ? (
              <p className="text-status-failed m-0 text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
      {menuAnchor && askMode === "ai" ? (
        <AnchoredMenu anchor={menuAnchor} label="Model" onClose={() => setMenuOpen(false)}>
          <ModelMenuItems
            models={models}
            model={modelId}
            effort={effortChoice}
            onModel={(next) => {
              setModel(next);
              setError(null);
              persist({ ...current, model: next });
            }}
            onEffort={(next) => {
              setEffortChoice(next);
              persist({ ...current, effort: next });
            }}
          />
        </AnchoredMenu>
      ) : null}
      {moreAnchor ? (
        <AnchoredMenu
          anchor={moreAnchor}
          label="Question actions"
          align="end"
          onClose={() => setMoreAnchor(null)}
        >
          <IconMenuItem
            icon={<FilePen size={15} aria-hidden="true" />}
            disabled={savingDraft}
            onClick={() => void saveDraft()}
          >
            Save draft
          </IconMenuItem>
        </AnchoredMenu>
      ) : null}
    </div>
  );
}
