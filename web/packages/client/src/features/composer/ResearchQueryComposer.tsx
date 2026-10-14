// The Home composer (`07-client-architecture.md` §6, ported from
// `ResearchQueryComposer.tsx`).
//
// Kept: the growing textarea, `isComposerSubmitShortcut` (⌘↵ on Apple
// platforms, Ctrl↵ elsewhere), Tab as the model cycle (`launcherTabAction`, now one
// dimension), and draft persistence of the prompt and model.
//
// Dropped: the "Ask network" toggle, adapter cycling, the custom-model field
// and per-model effort (effort is fixed at medium, `04-agent-runtime.md` §1).

import type { ModelInfo } from "@session/shared";
import {
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  composerTextareaHeight,
  DEFAULT_MODEL_ID,
  launcherTabAction,
  MODEL_REGISTRY,
} from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Globe, LoaderCircle } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useCreateResearchTree, useMe, useRuntimeConfig } from "../../api/queries.js";
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
import { GHOST_TRIGGER } from "../../ui/surfaces.js";

import { oversizeRefusal } from "./limits.js";
import { useRemoteComposerDraft } from "./useRemoteComposerDraft.js";

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

export function ResearchQueryComposer({
  workspaceId,
  tools,
}: {
  workspaceId: string;
  /** Extra icon controls rendered after the model picker, such as the report
   * import trigger. */
  tools?: ReactNode;
}) {
  const navigate = useNavigate();
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useRemoteComposerDraft(draftKey, (draft) => {
    setPrompt(draft.text);
    setModel(draft.model ?? defaultModel ?? DEFAULT_MODEL_ID);
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

  const persist = useCallback(
    (next: { text: string; model: string }) => {
      if (next.text.trim() === "") {
        clearDraft(draftKey);
        return;
      }
      setDraft(draftKey, next);
    },
    [clearDraft, draftKey, setDraft],
  );

  const updatePrompt = (text: string) => {
    setPrompt(text);
    persist({ text, model });
  };

  const updateModel = (next: string) => {
    setModel(next);
    persist({ text: prompt, model: next });
    window.requestAnimationFrame(() => promptRef.current?.focus());
  };

  const canSubmit = prompt.trim() !== "" && !submitting && workspaceId !== "" && selected !== null;

  async function submit() {
    if (!canSubmit || !selected) return;
    // The same ceilings the report import applies, refused with the same
    // sentence (`features/composer/limits.ts`).
    const refusal = oversizeRefusal(prompt.trim(), "question");
    if (refusal) {
      setError(refusal);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const detail = await createTree.mutateAsync({
        prompt: prompt.trim(),
        model: selected.id,
        workspaceId,
      });
      setPrompt("");
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
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
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
          // (`launcherKeyboard`). It is attached to the field rather than the form
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
          aria-label={submitting ? "Starting" : "Start research"}
        >
          {submitting ? (
            <>
              <LoaderCircle className="session-spin" size={12} aria-hidden="true" />
              <span>Starting…</span>
            </>
          ) : (
            <ComposerSubmitShortcutGlyph ariaHidden />
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
