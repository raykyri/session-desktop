// An unsent draft, open in its own view (the desktop's `ResearchDraftView.tsx`):
// the question as the header's title, then its ask box labelled "Draft".
// Opening a draft never focuses the box. Edits save as you type and when the
// view closes, and an added or removed image saves at once when the draft has
// text (otherwise with the next text edit); once a send starts nothing more is
// saved. ⌘S (Ctrl+S) saves an edit not yet saved at once and shows a toast.
// Send starts the research with the Home ask box's model and effort and
// removes the draft; a failed send keeps the view open with the error.

import type { ResearchDraft, ResearchImageAttachment } from "@session/shared";
import { DEFAULT_MODEL_ID } from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { deleteResearchDraft } from "../../api/api.js";
import {
  useCreateResearchTree,
  useMe,
  useRuntimeConfig,
  useSaveResearchDraft,
} from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import {
  createResearchDraftAutosave,
  createResearchDraftImageSave,
} from "../../lib/researchDraftAutosave.js";
import { researchImageBlockReason, researchImages } from "../../lib/researchImages.js";
import { errorMessage, pushToast } from "../../lib/toast.js";
import { homeDraftKey, useDraftsStore } from "../../stores/drafts.js";
import { useSettingsStore } from "../../stores/settings.js";
import { IconButton } from "../../ui/Button.js";
import {
  composerSendChord,
  isComposerSubmitShortcut,
  useRequireCmdEnterToSend,
} from "../../ui/ComposerSubmitShortcut.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { composerModels, resolvedEffort } from "../composer/QuestionModelPicker.js";
import { ImageStrip, useImageInput } from "../composer/images.js";

const SAVE_DELAY_MS = 500;

interface DraftSaver {
  save: ReturnType<typeof createResearchDraftImageSave<ResearchImageAttachment>>;
  autosave: ReturnType<typeof createResearchDraftAutosave>;
}

/** ⌘S on Apple platforms, Ctrl+S elsewhere. */
function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return false;
  return event.metaKey !== event.ctrlKey;
}

export function DraftView({ draft, workspaceId }: { draft: ResearchDraft; workspaceId: string }) {
  const navigate = useNavigate();
  const me = useMe();
  const runtimeConfig = useRuntimeConfig();
  const saveDraft = useSaveResearchDraft();
  const createTree = useCreateResearchTree();
  const defaultModel = useSettingsStore((state) => state.settings.defaultModel);
  const homeDraft = useDraftsStore((state) => state.get(homeDraftKey(workspaceId)));

  const [value, setValue] = useState(draft.prompt);
  const [images, setImages] = useState<ResearchImageAttachment[]>(() =>
    researchImages(draft.attachments),
  );
  const imagesRef = useRef(images);
  const [sending, setSending] = useState(false);
  const requireCmdEnter = useRequireCmdEnterToSend();
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveRef = useRef(saveDraft.mutateAsync);
  useLayoutEffect(() => {
    imagesRef.current = images;
    saveRef.current = saveDraft.mutateAsync;
  });

  // The saver and its autosave are made once per mounted draft (the route
  // keys this view by the draft's id) and flushed when the view closes.
  const saverRef = useRef<DraftSaver | null>(null);
  useEffect(() => {
    const save = createResearchDraftImageSave<ResearchImageAttachment>(
      imagesRef.current,
      (prompt, changed) =>
        saveRef.current({
          id: draft.id,
          workspaceId: draft.workspaceId,
          prompt,
          ...(changed ? { images: changed.map((image) => image.id) } : {}),
        }),
    );
    const autosave = createResearchDraftAutosave({
      initial: draft.prompt,
      delayMs: SAVE_DELAY_MS,
      save: (prompt) => save(prompt, imagesRef.current),
      onError: setError,
    });
    saverRef.current = { save, autosave };
    return () => {
      autosave.flush();
      saverRef.current = null;
    };
    // One saver per draft; the stored prompt it starts from is the one the
    // view opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  useEffect(() => saverRef.current?.autosave.edit(value), [value]);
  // Images save with the current text; with no text, the next text edit
  // saves them.
  const shownImagesRef = useRef(images);
  useEffect(() => {
    const saver = saverRef.current;
    if (!saver || images === shownImagesRef.current || sendingRef.current || !value.trim()) return;
    shownImagesRef.current = images;
    void saver.save(value, images).catch((failure: unknown) => {
      if (!sendingRef.current) setError(errorMessage(failure));
    });
    // Saves on image changes only; text edits go through the autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 96)}px`;
  }, [value]);

  const imageInput = useImageInput({
    images,
    disabled: sending,
    onImagesChange: (update) => setImages((current) => update(current)),
  });

  // The question goes with the Home ask box's model and effort.
  const models = composerModels(runtimeConfig.data?.models, me.data?.isAdmin === true);
  const modelId = homeDraft?.model ?? defaultModel ?? DEFAULT_MODEL_ID;
  const model = models.find((candidate) => candidate.id === modelId) ?? models[0] ?? null;
  const imageBlock = researchImageBlockReason(model, images);
  const imageProblem = imageInput.error ?? imageBlock;

  async function send() {
    const prompt = value.trim();
    if (!prompt || sending || !model || imageBlock || imageInput.saving > 0) return;
    setSending(true);
    sendingRef.current = true;
    setError(null);
    saverRef.current?.autosave.finish();
    try {
      const detail = await createTree.mutateAsync({
        prompt,
        model: model.id,
        effort: resolvedEffort(model.id, homeDraft?.effort),
        workspaceId: draft.workspaceId,
        ...(images.length > 0 ? { images: images.map((image) => image.id) } : {}),
      });
      // The draft is gone once its question is asked; a failure to remove it
      // leaves it listed rather than failing the send.
      void deleteResearchDraft(draft.id).then(
        () => pushToast({ title: "Sent. Moved from Drafts to Unfiled." }),
        (failure: unknown) =>
          pushToast({
            title: `The question was sent, but its draft couldn't be deleted. ${errorMessage(failure)}`,
            tone: "error",
          }),
      );
      void navigate({
        to: "/r/$treeId",
        params: { treeId: detail.tree.id },
        search: { ws: workspaceId },
      });
    } catch (failure) {
      saverRef.current?.autosave.resume();
      sendingRef.current = false;
      setError(errorMessage(failure));
      setSending(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSaveShortcut(event)) return;
    // Handled even when there is nothing to save, so the browser's own ⌘S
    // does not run.
    event.preventDefault();
    if (sendingRef.current) return;
    const saver = saverRef.current;
    if (!saver) return;
    saver.autosave.saveNow().then(
      (wrote) => {
        if (wrote) pushToast({ title: "Draft saved." });
      },
      // The autosave's onError shows the failure under the box.
      () => undefined,
    );
  };

  const title = draft.prompt.trim() || "Draft";
  const canSend = value.trim() !== "" && !sending && !imageBlock && imageInput.saving === 0;
  return (
    // ⌘S is taken anywhere in the view, as the desktop's draft column does.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      className="bg-surface-feed flex h-full min-h-0 flex-col"
      aria-label={`Draft: ${title}`}
      onKeyDown={onKeyDown}
    >
      <header className="border-border-divider flex min-h-11 shrink-0 items-center gap-1 border-b py-2 pr-3 pl-4">
        <IconButton
          label="Back to Drafts"
          className="-ml-1.5"
          onClick={() => void navigate({ to: "/drafts", search: { ws: workspaceId } })}
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </IconButton>
        <h1 className="text-fg-heading m-0 line-clamp-4 min-w-0 flex-1 text-[length:calc(var(--fs-base)+1px)] font-semibold [overflow-wrap:anywhere]">
          {title}
        </h1>
      </header>
      <div className="research-reading-surface min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-feed mx-auto w-full px-2 pt-3 pb-6">
          <div
            className="border-border-strong bg-surface-feed-field focus-within:border-accent flex flex-col rounded-[10px] border py-2 pr-2 pl-3 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
            {...imageInput.fieldProps}
          >
            <b className="text-fg-muted text-xs font-semibold">Draft</b>
            <ImageStrip
              images={images}
              saving={imageInput.saving}
              onRemove={sending ? undefined : imageInput.remove}
            />
            <textarea
              ref={textareaRef}
              value={value}
              placeholder="Write the question"
              aria-label="Draft question"
              disabled={sending}
              className="text-fg-strong placeholder:text-fg-faint block min-h-24 w-full resize-none border-0 bg-transparent px-0 py-1 text-[length:calc(var(--fs-base)+1px)] leading-[1.45] outline-none"
              onChange={(event) => {
                setValue(event.currentTarget.value);
                setError(null);
                imageInput.clearError();
              }}
              onKeyDown={(event) => {
                if (isComposerSubmitShortcut(event, undefined, requireCmdEnter)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="mt-1 flex items-center justify-end">
              <button
                type="button"
                className={cn(
                  "border-border-control bg-control text-fg-control hover:not-disabled:bg-control-hover disabled:text-fg-disabled grid size-[30px] place-items-center rounded-md border p-0",
                  FOCUS_RING,
                )}
                disabled={!canSend}
                aria-label="Send"
                title={`Send (${composerSendChord(requireCmdEnter)})`}
                onClick={() => void send()}
              >
                {sending ? (
                  <LoaderCircle className="session-spin" size={15} aria-hidden="true" />
                ) : (
                  <ArrowRight size={15} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
          {imageProblem ? (
            <p className="text-status-failed mt-1.5 mb-0 text-sm" role="alert">
              {imageProblem}
            </p>
          ) : null}
          {error ? (
            <p className="text-status-failed mt-1.5 mb-0 text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
