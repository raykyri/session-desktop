// Dedicated view for editing an unsent research draft (`ResearchDraftView.tsx`).
// Draft text and image attachments autosave on change and when unmounting.
// Keyboard shortcut ⌘S / Ctrl+S saves immediately and displays a status toast.
// Submitting launches the research run using configured model and effort settings,
// then deletes the draft upon success.

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
  const valueRef = useRef(value);
  // Tracks image attachments from the last successful save.
  const savedImagesRef = useRef<readonly ResearchImageAttachment[]>(images);
  const [sending, setSending] = useState(false);
  const requireCmdEnter = useRequireCmdEnterToSend();
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveRef = useRef(saveDraft.mutateAsync);
  useLayoutEffect(() => {
    imagesRef.current = images;
    valueRef.current = value;
    saveRef.current = saveDraft.mutateAsync;
  });

  // Instantiate autosave handler once per draft id; flush changes on unmount.
  const saverRef = useRef<DraftSaver | null>(null);
  /** Persists pending image changes alongside current draft text. Returns null if no changes require saving. */
  const saveUnsavedImages = (saver: DraftSaver): Promise<void> | null => {
    const current = imagesRef.current;
    if (current === savedImagesRef.current || sendingRef.current || !valueRef.current.trim())
      return null;
    const saving = saver.save(valueRef.current, current);
    saving.catch((failure: unknown) => {
      if (!sendingRef.current) setError(errorMessage(failure));
    });
    return saving;
  };
  useEffect(() => {
    const saveChanged = createResearchDraftImageSave<ResearchImageAttachment>(
      imagesRef.current,
      (prompt, changed) =>
        saveRef.current({
          id: draft.id,
          workspaceId: draft.workspaceId,
          prompt,
          ...(changed ? { images: changed.map((image) => image.id) } : {}),
        }),
    );
    const save = async (prompt: string, current: readonly ResearchImageAttachment[]) => {
      await saveChanged(prompt, current);
      savedImagesRef.current = current;
    };
    const autosave = createResearchDraftAutosave({
      initial: draft.prompt,
      delayMs: SAVE_DELAY_MS,
      save: (prompt) => save(prompt, imagesRef.current),
      onError: setError,
    });
    const saver = { save, autosave };
    saverRef.current = saver;
    return () => {
      if (!autosave.flush()) void saveUnsavedImages(saver)?.catch(() => undefined);
      saverRef.current = null;
    };
    // Initialize autosave instance once per draft id using the initial prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  useEffect(() => saverRef.current?.autosave.edit(value), [value]);
  // Persist attachment updates when image selection changes.
  useEffect(() => {
    const saver = saverRef.current;
    if (saver) void saveUnsavedImages(saver)?.catch(() => undefined);
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

  // Resolve model configuration from draft settings or defaults.
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
      // Delete the draft upon successful run creation; failure to delete
      // does not abort the run.
      void deleteResearchDraft(draft.id).then(
        () => pushToast({ title: "Sent. Moved from Drafts to Unfiled." }),
        (failure: unknown) =>
          pushToast({
            title: `The question was sent, but the draft could not be deleted. ${errorMessage(failure)}`,
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
    // Prevent browser default save action even when no changes are pending.
    event.preventDefault();
    if (sendingRef.current) return;
    const saver = saverRef.current;
    if (!saver) return;
    saver.autosave
      .saveNow()
      .then(async (wrote) => {
        if (wrote) return true;
        const saving = saveUnsavedImages(saver);
        if (!saving) return false;
        await saving;
        return true;
      })
      .then(
        (wrote) => {
          if (wrote) pushToast({ title: "Draft saved." });
        },
        // Autosave error handler displays failure messages below the editor.
        () => undefined,
      );
  };

  const title = draft.prompt.trim() || "Draft";
  const canSend = value.trim() !== "" && !sending && !imageBlock && imageInput.saving === 0;
  return (
    // Handle ⌘S / Ctrl+S shortcut globally across the draft view.
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
