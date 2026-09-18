// The Home composer (`07-client-architecture.md` §6, ported from
// `ResearchQueryComposer.tsx`).
//
// Kept: the growing textarea, `isComposerSubmitShortcut` with
// `requireCmdEnterToSend`, Tab as the model cycle (`launcherTabAction`, now one
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
import { Loader, Paperclip, X } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { addJournalEntry, uploadDocuments } from "../../api/api.js";
import { queryKeys, useCreateResearchTree, useMe, useRuntimeConfig } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { errorMessage } from "../../lib/toast.js";
import { homeDraftKey, useDraftsStore } from "../../stores/drafts.js";
import { useSettingsStore } from "../../stores/settings.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../../ui/ComposerSubmitShortcut.js";
import { Menu, MenuItem } from "../../ui/Menu.js";
import { FORM_FIELD } from "../../ui/surfaces.js";

import { ModelIcon } from "./modelIcon.js";

/** A prompt that is nothing but one web URL is a link to keep, not a question
 * to ask (`10` §2). Anything with a second token is a question that happens to
 * contain a link. */
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
 * configured provider, and one that does not is listed and disabled rather
 * than hidden — the desktop's `AgentSetupGuide` is not ported (`10` §1). */
export function composerModels(
  runtimeModels: readonly ModelInfo[] | undefined,
  isAdmin: boolean,
): ModelInfo[] {
  if (runtimeModels && runtimeModels.length > 0) {
    return runtimeModels.filter((model) => !model.adminOnly || isAdmin);
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

/** A restored draft knows only the ids; the names arrive with the chips the
 * next upload produces, and until then the chip carries the id's own weight. */
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

export function ResearchQueryComposer({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const me = useMe();
  const runtimeConfig = useRuntimeConfig();
  const createTree = useCreateResearchTree();
  const requireCmdEnterToSend = useSettingsStore((state) => state.settings.requireCmdEnterToSend);
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
    setPrompt(text);
    persist({ text, model, documentIds });
  };

  const updateModel = (next: string) => {
    setModel(next);
    persist({ text: prompt, model: next, documentIds });
    window.requestAnimationFrame(() => promptRef.current?.focus());
  };

  const attach = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0 || workspaceId === "") return;
      const pending: Attachment[] = files.map((file, index) => ({
        key: `upload:${Date.now()}:${index}:${file.name}`,
        name: file.name,
        byteSize: file.size,
        status: "uploading",
        progress: 0,
      }));
      const keys = pending.map((attachment) => attachment.key);
      setAttachments((current) => [...current, ...pending]);
      setError(null);
      void uploadDocuments(workspaceId, files, (progress) => {
        setAttachments((current) =>
          current.map((attachment) =>
            keys.includes(attachment.key)
              ? { ...attachment, progress: progress.fraction }
              : attachment,
          ),
        );
      })
        .then((documents) => {
          void client.invalidateQueries({ queryKey: queryKeys.documents(workspaceId) });
          setAttachments((current) => {
            const next = current.filter((attachment) => !keys.includes(attachment.key));
            const merged = [...next, ...documents.map(attachmentFromDocument)];
            persist({
              text: prompt,
              model,
              documentIds: merged
                .filter((attachment) => attachment.status === "ready")
                .map((attachment) => attachment.key),
            });
            return merged;
          });
        })
        .catch((failure: unknown) => {
          const message = errorMessage(failure);
          setError(message);
          setAttachments((current) =>
            current.map((attachment) =>
              keys.includes(attachment.key)
                ? { ...attachment, status: "failed" as const, error: message }
                : attachment,
            ),
          );
        });
    },
    [client, model, persist, prompt, workspaceId],
  );

  const removeAttachment = (key: string) => {
    setAttachments((current) => {
      const next = current.filter((attachment) => attachment.key !== key);
      persist({
        text: prompt,
        model,
        documentIds: next
          .filter((attachment) => attachment.status === "ready")
          .map((attachment) => attachment.key),
      });
      return next;
    });
  };

  const uploading = attachments.some((attachment) => attachment.status === "uploading");
  const canSubmit =
    prompt.trim() !== "" && !submitting && !uploading && workspaceId !== "" && selected !== null;

  async function submit() {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const link = bareUrl(prompt);
      if (link) {
        // A bare URL is a journal entry, not a run. The feed is keyset
        // paginated, so the new row arrives through a refetch rather than a
        // splice.
        await addJournalEntry(link);
        await client.invalidateQueries({ queryKey: ["activity"] });
        setPrompt("");
        setAttachments([]);
        clearDraft(draftKey);
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
      aria-label="New research"
      className={cn(
        "border-border-control bg-surface-field flex flex-col gap-2 rounded-lg border p-2",
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
        aria-label="What would you like to investigate?"
        placeholder="What would you like to investigate?"
        className={cn(
          FORM_FIELD,
          "resize-none border-0 bg-transparent px-1 py-1 focus:shadow-none",
        )}
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
          if (!isComposerSubmitShortcut(event, requireCmdEnterToSend)) return;
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
              {attachment.document?.extractionStatus === "failed" ? <span>no text</span> : null}
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

      <div className="flex items-center gap-2">
        <Menu
          side="top"
          align="start"
          label="Model"
          trigger={
            <ControlButton size="sm" className="gap-1.5" title="Model (Tab)">
              <ModelIcon modelId={selected?.id ?? model} />
              <span className="truncate">{selected?.label ?? model}</span>
            </ControlButton>
          }
        >
          {models.map((candidate) => (
            <MenuItem
              key={candidate.id}
              disabled={!candidate.available}
              hint={candidate.available ? undefined : "unavailable"}
              onClick={() => updateModel(candidate.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ModelIcon modelId={candidate.id} />
                <span className="truncate">{candidate.label}</span>
              </span>
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

        <div className="flex-1" />

        <ControlButton
          type="submit"
          size="sm"
          disabled={!canSubmit}
          aria-label={submitting ? "Starting research" : "Start research"}
          title={submitting ? "Starting research" : "Start research"}
        >
          <ComposerSubmitShortcutGlyph requireCmdEnter={requireCmdEnterToSend} ariaHidden />
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
