// The model and effort an ask box sends with (`09-research-document-view.md`
// §6), the web counterpart of the desktop `ResearchQuestionModelPicker`. The
// trigger shows the selected model's icon and name and the effort; the menu
// lists the models this account may use, then the efforts the selected model
// accepts. A follow-up may run on any registry model (PLAN decision 2.8).

import type { ModelInfo, ReasoningEffort } from "@session/shared";
import { findModel } from "@session/shared";
import { Bot, ChevronDown } from "lucide-react";
import { useMemo } from "react";

import { useMe, useRuntimeConfig } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { GeminiMark } from "../../ui/ModelMark.js";
import { GHOST_TRIGGER } from "../../ui/surfaces.js";
import { launchableModels } from "../composer/ResearchQueryComposer.js";

export interface ModelChoice {
  model: string;
  /** Null: the model's default effort. */
  effort: ReasoningEffort | null;
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A model's icon, by its family. */
export function ModelIcon({ modelId, size = 12 }: { modelId: string; size?: number }) {
  const adapter = findModel(modelId)?.adapter;
  return adapter === "gemini" ? <GeminiMark size={size} /> : <Bot size={size} aria-hidden="true" />;
}

/** The models this account may launch on. */
export function useUsableModels(): ModelInfo[] {
  const runtime = useRuntimeConfig().data;
  const me = useMe().data ?? null;
  return useMemo(
    () =>
      launchableModels((runtime?.models ?? []).filter((model) => !model.adminOnly || me?.isAdmin)),
    [me, runtime],
  );
}

/** The efforts `modelId` accepts, lowest first, and its default. */
export function modelEfforts(modelId: string): {
  efforts: readonly ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
} {
  const entry = findModel(modelId);
  return { efforts: entry?.efforts ?? [], defaultEffort: entry?.defaultEffort ?? null };
}

export function ModelPicker({
  choice,
  models,
  disabled = false,
  onChange,
}: {
  choice: ModelChoice;
  models: readonly ModelInfo[];
  disabled?: boolean;
  onChange: (choice: ModelChoice) => void;
}) {
  const label =
    models.find((model) => model.id === choice.model)?.label ??
    findModel(choice.model)?.label ??
    choice.model;
  const { efforts, defaultEffort } = modelEfforts(choice.model);
  const effort = choice.effort ?? defaultEffort;
  return (
    <Menu
      size="sm"
      align="start"
      side="top"
      label="Model and effort"
      trigger={
        <button
          type="button"
          className={cn(GHOST_TRIGGER, "max-w-full")}
          disabled={disabled}
          title="Model for this follow-up"
          aria-label={`Model: ${label}${effort ? `, ${EFFORT_LABEL[effort]} effort` : ""}`}
        >
          <ModelIcon modelId={choice.model} />
          <span className="min-w-0 truncate">{label}</span>
          {effort ? <span className="text-fg-muted shrink-0">· {EFFORT_LABEL[effort]}</span> : null}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      }
    >
      <MenuGroup label="Model">
        {models.map((model) => (
          <MenuItem
            key={model.id}
            selected={model.id === choice.model}
            disabled={!model.available}
            onClick={() => onChange({ model: model.id, effort: null })}
          >
            <span className="inline-flex items-center gap-1.5">
              <ModelIcon modelId={model.id} />
              {model.label}
            </span>
          </MenuItem>
        ))}
      </MenuGroup>
      {efforts.length > 1 ? (
        <>
          <MenuSeparator />
          <MenuGroup label="Effort">
            {efforts.map((value) => (
              <MenuItem
                key={value}
                selected={value === effort}
                onClick={() => onChange({ model: choice.model, effort: value })}
              >
                {EFFORT_LABEL[value]}
              </MenuItem>
            ))}
          </MenuGroup>
        </>
      ) : null}
    </Menu>
  );
}
