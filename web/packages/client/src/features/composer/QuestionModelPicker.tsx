// The model menu of the ask boxes (the desktop's
// `ResearchQuestionModelPicker.tsx` and the model `LauncherSelect` of
// `ResearchQueryComposer.tsx`): one row per registry model this account may
// use, with the model family's icon, then an Effort submenu with Default and
// the efforts the chosen model accepts. The desktop lists each agent's
// presets; the web lists registry models, so there is no Custom model.
// Admin-only models (Fable) are listed for admins only, as the server allows
// them only to admins.
//
// Home's ask box opens the menu from its Ask segment (`ModelMenuItems` in an
// `AnchoredMenu`); the thread page's ask boxes, a note's follow-up field and
// the editor's "Ask as a question" use `QuestionModelPicker`, the same menu
// behind a trigger that shows the model and its effort. A follow-up may run
// on any registry model (PLAN decision 2.8).

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ModelInfo, ReasoningEffort } from "@session/shared";
import { findModel, MODEL_REGISTRY } from "@session/shared";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo } from "react";

import { useMe, useRuntimeConfig } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { GeminiMark } from "../../ui/ModelMark.js";
import {
  GHOST_TRIGGER,
  MENU_ITEM,
  MENU_ITEM_SIZE,
  POPOVER_SURFACE,
  POPOVER_SURFACE_SIZE,
} from "../../ui/surfaces.js";

/** The model and effort a question is asked with. */
export interface ModelChoice {
  model: string;
  /** Null: the model's default effort. */
  effort: ReasoningEffort | null;
}

/** The models this account may launch on. The registry says which exist and
 * who may use them; the deployment's runtime config says which have a
 * configured provider. Models without one are hidden, unless none has one:
 * then every model is listed, disabled, so the menu explains itself. */
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

/** The models this account may launch on, once the runtime config has
 * loaded (the thread page's ask boxes). */
export function useUsableModels(): ModelInfo[] {
  const runtime = useRuntimeConfig().data;
  const me = useMe().data ?? null;
  return useMemo(
    () =>
      launchableModels((runtime?.models ?? []).filter((model) => !model.adminOnly || me?.isAdmin)),
    [me, runtime],
  );
}

/** ⌃Tab steps to the next launchable model, wrapping. A model the
 * deployment cannot run is skipped rather than landed on. */
export function nextComposerModel(models: readonly ModelInfo[], current: string): string {
  const usable = models.filter((model) => model.available);
  if (usable.length === 0) return current;
  const index = usable.findIndex((model) => model.id === current);
  return usable[(index + 1) % usable.length]?.id ?? current;
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

/** The Effort submenu's options for a model: Default, then its efforts,
 * lowest first. */
export function effortOptionsFor(modelId: string): { value: string; label: string }[] {
  const model = findModel(modelId);
  if (!model) return [];
  return [
    { value: "", label: "Default" },
    ...model.efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
  ];
}

/** The effort a question goes with: the choice when the model accepts it,
 * else null (the model's default). A choice left over from another model
 * falls back silently, so the menu always shows what will run. */
export function resolvedEffort(modelId: string, choice: string | null | undefined): string | null {
  if (!choice) return null;
  const model = findModel(modelId);
  return model && (model.efforts as readonly string[]).includes(choice) ? choice : null;
}

/** "Ask with Gemini 3.8 Flash", "Ask with Claude Fable 5.1 (High)". */
export function askLabelFor(model: ModelInfo | null, effort: string | null): string {
  if (!model) return "Ask with a model";
  const effortLabel = effort ? EFFORT_LABELS[effort as ReasoningEffort] : null;
  return `Ask with ${model.label}${effortLabel ? ` (${effortLabel})` : ""}`;
}

/** A model's icon, by its family. */
export function ModelIcon({ modelId, size = 12 }: { modelId: string; size?: number }) {
  return findModel(modelId)?.adapter === "gemini" ? (
    <GeminiMark size={size} />
  ) : (
    <Bot size={size} aria-hidden="true" />
  );
}

/** The rows of the model menu, for an `AnchoredMenu`. */
export function ModelMenuItems({
  models,
  model,
  effort,
  onModel,
  onEffort,
}: {
  models: readonly ModelInfo[];
  model: string;
  /** The chosen effort, "" for the model's default. */
  effort: string;
  onModel: (modelId: string) => void;
  onEffort: (effort: string) => void;
}) {
  const efforts = effortOptionsFor(model);
  const selectedEffort = efforts.some((option) => option.value === effort) ? effort : "";
  return (
    <>
      <BaseMenu.Group aria-label="Model">
        {models.map((candidate) => (
          <MenuItem
            key={candidate.id}
            disabled={!candidate.available}
            hint={candidate.available ? undefined : "unavailable"}
            selected={candidate.id === model}
            onClick={() => onModel(candidate.id)}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="text-fg-muted inline-flex shrink-0">
                <ModelIcon modelId={candidate.id} />
              </span>
              <span className="truncate">{candidate.label}</span>
            </span>
          </MenuItem>
        ))}
      </BaseMenu.Group>
      {efforts.length > 1 ? (
        <>
          <MenuSeparator />
          <BaseMenu.SubmenuRoot>
            <BaseMenu.SubmenuTrigger className={cn(MENU_ITEM, MENU_ITEM_SIZE.md)}>
              <span className="inline-flex w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Effort</span>
              <span className="text-fg-muted text-xs">
                {efforts.find((option) => option.value === selectedEffort)?.label}
              </span>
              <ChevronRight size={13} aria-hidden="true" className="text-fg-muted shrink-0" />
            </BaseMenu.SubmenuTrigger>
            <BaseMenu.Portal>
              <BaseMenu.Positioner side="right" align="start" className="z-(--z-popover)">
                <BaseMenu.Popup
                  aria-label="Effort"
                  className={cn(POPOVER_SURFACE, POPOVER_SURFACE_SIZE.md, "min-w-36")}
                >
                  {efforts.map((option) => (
                    <MenuItem
                      key={option.value || "default"}
                      selected={option.value === selectedEffort}
                      onClick={() => onEffort(option.value)}
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </BaseMenu.Popup>
              </BaseMenu.Positioner>
            </BaseMenu.Portal>
          </BaseMenu.SubmenuRoot>
        </>
      ) : null}
    </>
  );
}

/** The model menu behind a trigger of its own: the chosen model's icon and
 * name, and the effort it runs at (the chosen one, else the model's
 * default). A model change starts at that model's default effort. */
export function QuestionModelPicker({
  choice,
  models,
  disabled = false,
  title = "Model for this follow-up",
  onChange,
}: {
  choice: ModelChoice;
  models: readonly ModelInfo[];
  disabled?: boolean;
  /** The trigger's tooltip. */
  title?: string;
  onChange: (choice: ModelChoice) => void;
}) {
  const label =
    models.find((model) => model.id === choice.model)?.label ??
    findModel(choice.model)?.label ??
    choice.model;
  const chosen = resolvedEffort(choice.model, choice.effort) as ReasoningEffort | null;
  const effort = chosen ?? findModel(choice.model)?.defaultEffort ?? null;
  return (
    <Menu
      size="sm"
      align="start"
      side="top"
      label="Model"
      trigger={
        <button
          type="button"
          className={cn(GHOST_TRIGGER, "max-w-full")}
          disabled={disabled}
          title={title}
          aria-label={`Model: ${label}${effort ? `, ${EFFORT_LABELS[effort]} effort` : ""}`}
        >
          <ModelIcon modelId={choice.model} />
          <span className="min-w-0 truncate">{label}</span>
          {effort ? (
            <span className="text-fg-muted shrink-0">· {EFFORT_LABELS[effort]}</span>
          ) : null}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      }
    >
      <ModelMenuItems
        models={models}
        model={choice.model}
        effort={chosen ?? ""}
        onModel={(model) => {
          if (model !== choice.model) onChange({ model, effort: null });
        }}
        onEffort={(value) =>
          onChange({
            model: choice.model,
            effort: resolvedEffort(choice.model, value) as ReasoningEffort | null,
          })
        }
      />
    </Menu>
  );
}
