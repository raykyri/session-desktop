// The Home composer (`07-client-architecture.md` §6, ported from
// `ResearchQueryComposer.tsx`).
//
// Kept: the growing textarea, `isComposerSubmitShortcut` (⌘↵ on Apple
// platforms, Ctrl↵ elsewhere), Tab as the model cycle (`launcherTabAction`, now one
// dimension), and draft persistence — prompt, model, and the ids of whatever
// was attached.
//
// Dropped: the "Ask network" toggle, adapter cycling, the custom-model field
// and per-model effort (effort is fixed at medium, `04-agent-runtime.md` §1).
// Added: document attachments, which upload as soon as they are dropped so the
// extraction status is visible before the question is asked, and the bare-URL
// path, which saves a link to the journal instead of launching a run (`10` §2).

import type { DocumentInfo, ModelInfo } from "@session/shared";
import {
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  composerTextareaHeight,
  DEFAULT_MODEL_ID,
  launcherTabAction,
  MODEL_REGISTRY,
} from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Globe, Loader, LoaderCircle, Paperclip, X } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { addJournalEntry, uploadDocuments } from "../../api/api.js";
import { queryKeys, useCreateResearchTree, useMe, useRuntimeConfig } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { errorMessage, pushToast } from "../../lib/toast.js";
import { homeDraftKey, markDraftEdited, useDraftsStore } from "../../stores/drafts.js";
import { useSettingsStore } from "../../stores/settings.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../../ui/ComposerSubmitShortcut.js";
import { Menu, MenuItem } from "../../ui/Menu.js";
import { GHOST_TRIGGER } from "../../ui/surfaces.js";

import { oversizeRefusal } from "./limits.js";
import { useRemoteComposerDraft } from "./useRemoteComposerDraft.js";

/** A prompt containing only one web URL is saved as a Journal bookmark
 * (`10` §2). Additional text causes the prompt to run as a research query. */
export function bareUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  const url = URL.parse(trimmed);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  return url.toString();
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The models this account may launch on. The registry says which exist and
 * who may use them; the deployment's runtime config says which have a
 * configured provider. Models without one are hidden, unless none has one:
 * then every model is listed, disabled, so the picker explains itself rather
 * than standing empty — the desktop's `AgentSetupGuide` is not ported
 * (`10` §1). */
export function composerModels(
  runtimeModels: readonly ModelInfo[] | undefined,
  isAdmin: boolean,
): ModelInfo[] {
  if (runtimeModels && runtimeModels.length > 0) {
    return launchableModels(runtimeModels.filter((model) => !model.adminOnly || isAdmin));
  }
  return MODEL_REGISTRY.filter((model) => !model.adminOnly || isAdmin).map((model) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    adminOnly: model.adminOnly,
    available: true,
    supportsFiles: model.supportsFiles,
    supportsImages: model.supportsImages,
  }));
}

/** The available models, or all of them when none is available. */
export function launchableModels(models: readonly ModelInfo[]): ModelInfo[] {
  const available = models.filter((model) => model.available);
  return available.length > 0 ? available : [...models];
}

/** Tab steps to the next launchable model, wrapping. A model the deployment
 * cannot run is skipped rather than landed on. */
export function nextComposerModel(models: readonly ModelInfo[], current: string): string {
  const usable = models.filter((model) => model.available);
  if (usable.length === 0) return current;
  const index = usable.findIndex((model) => model.id === current);
  return usable[(index + 1) % usable.length]?.id ?? current;
}

interface Attachment {
  /** Temporary id until the upload answers, then the document id. */
  key: string;
  name: string;
  byteSize: number;
  status: "uploading" | "ready" | "failed";
  /** 0..1 while uploading, null when the total is unknown. */
  progress: number | null;
  document?: DocumentInfo;
  error?: string;
}

/** Restored drafts contain only document IDs until upload metadata becomes
 * available. */
function attachmentsFromDraft(documentIds: readonly string[] | undefined): Attachment[] {
  return (documentIds ?? []).map((id) => ({
    key: id,
    name: "Attachment",
    byteSize: 0,
    status: "ready" as const,
    progress: 1,
  }));
}

function attachmentFromDocument(document: DocumentInfo): Attachment {
  return {
    key: document.id,
    name: document.name,
    byteSize: document.byteSize,
    status: "ready",
    progress: 1,
    document,
  };
}

export function ResearchQueryComposer({
  workspaceId,
  tools,
}: {
  workspaceId: string;
  /** Extra icon controls rendered after the attach button, such as the
   * report import trigger. */
  tools?: ReactNode;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const me = useMe();
  const runtimeConfig = useRuntimeConfig();
  const createTree = useCreateResearchTree();
  const defaultModel = useSettingsStore((state) => state.settings.defaultModel);

  const draftKey = homeDraftKey(workspaceId);
  const readDraft = useDraftsStore((state) => state.get);
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);

  // Seeded from the stored draft rather than restored by an effect: an effect
  // would paint one empty frame first, and on a slow list that reads as a lost
  // question.
  const [prompt, setPrompt] = useState(() => readDraft(draftKey)?.text ?? "");
  const [model, setModel] = useState(
    () => readDraft(draftKey)?.model ?? defaultModel ?? DEFAULT_MODEL_ID,
  );
  const [attachments, setAttachments] = useState<Attachment[]>(() =>
    attachmentsFromDraft(readDraft(draftKey)?.documentIds),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const latestComposer = useRef({ prompt, model, attachments });
  const uploadScope = useRef<object | null>(null);

  useLayoutEffect(() => {
    latestComposer.current = { prompt, model, attachments };
  }, [prompt, model, attachments]);

  useLayoutEffect(() => {
    uploadScope.current = {};
    return () => {
      uploadScope.current = null;
    };
  }, [draftKey]);

  const updateAttachments = useCallback((update: (current: Attachment[]) => Attachment[]) => {
    const next = update(latestComposer.current.attachments);
    latestComposer.current.attachments = next;
    setAttachments(next);
    return next;
  }, []);

  useRemoteComposerDraft(draftKey, (draft) => {
    setPrompt(draft.text);
    setModel(draft.model ?? defaultModel ?? DEFAULT_MODEL_ID);
    updateAttachments(() => attachmentsFromDraft(draft.documentIds));
  });

  const models = useMemo(
    () => composerModels(runtimeConfig.data?.models, me.data?.isAdmin === true),
    [runtimeConfig.data?.models, me.data?.isAdmin],
  );
  const selected = models.find((candidate) => candidate.id === model) ?? models[0] ?? null;

  // Switching workspace swaps drafts rather than carrying one question into
  // another workspace. Adjusting during render (the documented pattern for
  // state derived from a prop) rather than in an effect, which would show the
  // previous workspace's draft for a frame.
  const [lastDraftKey, setLastDraftKey] = useState(draftKey);
  if (lastDraftKey !== draftKey) {
    setLastDraftKey(draftKey);
    const draft = readDraft(draftKey);
    setPrompt(draft?.text ?? "");
    setModel(draft?.model ?? defaultModel ?? DEFAULT_MODEL_ID);
    setAttachments(attachmentsFromDraft(draft?.documentIds));
    setError(null);
  }

  // Grow the field to fit the committed value. Measuring in `onChange` can
  // catch WebKit between its native edit and React restoring the controlled
  // value; a layout effect keeps value and height in one pre-paint commit.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${composerTextareaHeight(textarea.scrollHeight)}px`;
  }, [prompt]);

  const documentIds = attachments
    .filter((attachment) => attachment.status === "ready")
    .map((attachment) => attachment.key);

  const persist = useCallback(
    (next: { text: string; model: string; documentIds: string[] }) => {
      if (next.text.trim() === "" && next.documentIds.length === 0) {
        clearDraft(draftKey);
        return;
      }
      setDraft(draftKey, next);
    },
    [clearDraft, draftKey, setDraft],
  );

  const updatePrompt = (text: string) => {
    latestComposer.current.prompt = text;
    setPrompt(text);
    persist({ text, model, documentIds });
  };

  const updateModel = (next: string) => {
    latestComposer.current.model = next;
    setModel(next);
    persist({ text: prompt, model: next, documentIds });
    window.requestAnimationFrame(() => promptRef.current?.focus());
  };

  const attach = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0 || workspaceId === "") return;
      markDraftEdited(draftKey);
      const scope = uploadScope.current;
      const pending: Attachment[] = files.map((file, index) => ({
        key: `upload:${Date.now()}:${index}:${file.name}`,
        name: file.name,
        byteSize: file.size,
        status: "uploading",
        progress: 0,
      }));
      const keys = pending.map((attachment) => attachment.key);
      updateAttachments((current) => [...current, ...pending]);
      setError(null);
      void uploadDocuments(workspaceId, files, (progress) => {
        if (uploadScope.current !== scope) return;
        updateAttachments((current) =>
          current.map((attachment) =>
            keys.includes(attachment.key)
              ? { ...attachment, progress: progress.fraction }
              : attachment,
          ),
        );
      })
        .then((documents) => {
          void client.invalidateQueries({ queryKey: queryKeys.documents(workspaceId) });
          if (uploadScope.current !== scope) return;
          if (
            !latestComposer.current.attachments.some((attachment) => keys.includes(attachment.key))
          )
            return;
          const merged = updateAttachments((current) => {
            const next = current.filter((attachment) => !keys.includes(attachment.key));
            const kept = documents.filter((_, index) =>
              current.some((attachment) => attachment.key === keys[index]),
            );
            return [...next, ...kept.map(attachmentFromDocument)];
          });
          persist({
            text: latestComposer.current.prompt,
            model: latestComposer.current.model,
            documentIds: merged
              .filter((attachment) => attachment.status === "ready")
              .map((attachment) => attachment.key),
          });
        })
        .catch((failure: unknown) => {
          if (uploadScope.current !== scope) return;
          const message = errorMessage(failure);
          setError(message);
          updateAttachments((current) =>
            current.map((attachment) =>
              keys.includes(attachment.key)
                ? { ...attachment, status: "failed" as const, error: message }
                : attachment,
            ),
          );
        });
    },
    [client, draftKey, persist, updateAttachments, workspaceId],
  );

  const removeAttachment = (key: string) => {
    const next = updateAttachments((current) =>
      current.filter((attachment) => attachment.key !== key),
    );
    persist({
      text: latestComposer.current.prompt,
      model: latestComposer.current.model,
      documentIds: next
        .filter((attachment) => attachment.status === "ready")
        .map((attachment) => attachment.key),
    });
  };

  const uploading = attachments.some((attachment) => attachment.status === "uploading");
  const canSubmit =
    prompt.trim() !== "" && !submitting && !uploading && workspaceId !== "" && selected !== null;
  // A prompt that is one URL is kept as a link, not sent as a question; the
  // button says so before it is pressed.
  const savesLink = bareUrl(prompt) !== null;

  async function submit() {
    if (!canSubmit || !selected) return;
    const link = bareUrl(prompt);
    // The same ceilings the report import applies, refused with the same
    // sentence (`features/composer/limits.ts`). A bare URL is a link to keep
    // rather than text to send, so it is not measured against them.
    const refusal = link ? null : oversizeRefusal(prompt.trim(), "question");
    if (refusal) {
      setError(refusal);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (link) {
        // A bare URL is a journal entry, not a run. The feed is keyset
        // paginated, so the new row arrives through a refetch rather than a
        // splice.
        await addJournalEntry(link);
        await client.invalidateQueries({ queryKey: ["activity"] });
        setPrompt("");
        setAttachments([]);
        clearDraft(draftKey);
        pushToast({ title: "Link saved to the journal", tone: "success" });
        return;
      }
      const detail = await createTree.mutateAsync({
        prompt: prompt.trim(),
        model: selected.id,
        workspaceId,
        ...(documentIds.length > 0 ? { documentIds } : {}),
      });
      setPrompt("");
      setAttachments([]);
      clearDraft(draftKey);
      void navigate({
        to: "/r/$treeId",
        params: { treeId: detail.tree.id },
        search: { ws: workspaceId },
      });
    } catch (failure) {
      // Shown here, where the user is looking, with every field intact for the
      // retry.
      setError(errorMessage(failure));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      aria-label="New thread"
      className={cn(
        "border-border-control bg-surface-field flex flex-col gap-2 rounded-lg border p-2",
        "focus-within:border-focus-ring",
        dragging && "border-focus-ring",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        attach([...event.dataTransfer.files]);
      }}
    >
      <textarea
        ref={promptRef}
        rows={2}
        value={prompt}
        aria-label="What do you want to investigate?"
        placeholder="What do you want to investigate?"
        className="research-composer-text text-fg-primary placeholder:text-fg-placeholder disabled:text-fg-disabled min-w-0 resize-none border-0 bg-transparent px-1 py-1 outline-none"
        style={{ maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT }}
        onChange={(event) => updatePrompt(event.currentTarget.value)}
        onKeyDown={(event) => {
          // One dimension left: Tab steps models when there are models to step
          // (`launcherKeyboard`). It lives on the field rather than on the form
          // because that is where the caret is when it is pressed.
          if (launcherTabAction(event, models.length > 1) === "cycle-model") {
            event.preventDefault();
            event.stopPropagation();
            updateModel(nextComposerModel(models, model));
            return;
          }
          if (!isComposerSubmitShortcut(event)) return;
          event.preventDefault();
          void submit();
        }}
      />

      {attachments.length > 0 ? (
        <ul aria-label="Attachments" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {attachments.map((attachment) => (
            <li
              key={attachment.key}
              className={cn(
                "border-border-divider bg-surface-fill-subtle flex items-center gap-1.5",
                "text-fg-secondary rounded-md border px-2 py-1 text-xs",
                attachment.status === "failed" && "border-danger-border text-danger-muted",
              )}
              title={attachment.error ?? attachment.name}
            >
              {attachment.status === "uploading" ? (
                <Loader size={11} aria-hidden="true" className="session-spin" />
              ) : null}
              <span className="max-w-40 truncate">{attachment.name}</span>
              {attachment.status === "uploading" ? (
                <span>
                  {attachment.progress === null
                    ? "uploading…"
                    : `${Math.round(attachment.progress * 100)}%`}
                </span>
              ) : attachment.status === "failed" ? (
                <span>failed</span>
              ) : attachment.byteSize > 0 ? (
                <span>{formatByteSize(attachment.byteSize)}</span>
              ) : null}
              {attachment.document?.extractionStatus === "pending" ? (
                <span>extracting…</span>
              ) : null}
              {attachment.document?.extractionStatus === "failed" ? (
                <span>No text extracted</span>
              ) : null}
              <IconButton
                label={`Remove ${attachment.name}`}
                className="size-3.5"
                onClick={() => removeAttachment(attachment.key)}
              >
                <X size={11} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Menu
          side="bottom"
          align="start"
          label="Model"
          size="sm"
          trigger={
            <button
              type="button"
              title="Model (Tab)"
              className={cn(GHOST_TRIGGER, "-ml-0.5 max-w-44")}
            >
              <span className="truncate">{selected?.label ?? model}</span>
              <ChevronDown size={13} aria-hidden="true" className="shrink-0" />
            </button>
          }
        >
          {models.map((candidate) => (
            <MenuItem
              key={candidate.id}
              disabled={!candidate.available}
              hint={candidate.available ? undefined : "unavailable"}
              selected={candidate.id === selected?.id}
              onClick={() => updateModel(candidate.id)}
            >
              <span className="truncate">{candidate.label}</span>
            </MenuItem>
          ))}
        </Menu>

        <IconButton
          label="Attach documents"
          title="Attach documents"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={14} aria-hidden="true" />
        </IconButton>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            attach(files);
          }}
        />
        {tools}

        <div className="flex-1" />

        <IconButton label="Public">
          <Globe size={14} aria-hidden="true" />
        </IconButton>

        <ControlButton
          type="submit"
          size="sm"
          className="gap-x-1.5"
          disabled={!canSubmit}
          aria-label={submitting ? "Starting" : savesLink ? "Save link" : "Start research"}
        >
          {submitting ? (
            <>
              <LoaderCircle className="session-spin" size={12} aria-hidden="true" />
              <span>Starting…</span>
            </>
          ) : (
            <>
              {savesLink ? <span>Save link</span> : null}
              <ComposerSubmitShortcutGlyph ariaHidden />
            </>
          )}
        </ControlButton>
      </div>

      {error ? (
        <p className="text-status-failed m-0 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
