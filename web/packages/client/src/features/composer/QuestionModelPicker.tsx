// The model menu of the ask boxes (the desktop's
// `ResearchQuestionModelPicker.tsx` and the model `LauncherSelect` of
// `ResearchQueryComposer.tsx`): one row per registry model this account may
// use, then an Effort submenu with the efforts the chosen model accepts. The
// desktop lists each agent's presets; the web lists registry models, so
// there is no Custom model. Admin-only models (Fable) are listed for admins
// only, as the server allows them only to admins.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ModelInfo, ReasoningEffort } from "@session/shared";
import { findModel, MODEL_REGISTRY } from "@session/shared";
import { ChevronRight } from "lucide-react";

import { cn } from "../../lib/cn.js";
import { MenuItem, MenuSeparator } from "../../ui/Menu.js";
import {
  MENU_ITEM,
  MENU_ITEM_SIZE,
  POPOVER_SURFACE,
  POPOVER_SURFACE_SIZE,
} from "../../ui/surfaces.js";

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
            {candidate.label}
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
