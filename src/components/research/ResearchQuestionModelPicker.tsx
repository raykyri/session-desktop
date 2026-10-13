import { useMemo, useState } from "react";
import type { RefObject } from "react";
import type { AgentAdapterMetadata } from "../../types";
import { LauncherSelect, type LauncherSelectOption } from "../LauncherSelect";
import { CUSTOM_MODEL, modelPresetsFor } from "../../lib/launcherModels";
import { adapterCanLaunchResearch } from "../../lib/adapterReadiness";
import {
  parseResearchModelChoice,
  researchEffortOptionsFor,
  researchModelChoiceValue,
  researchModelOptions,
  type ResearchLaunchChoice,
} from "./ResearchQueryComposer";
import { ResearchModelNameDialog } from "./ResearchModelNameDialog";

/** The agent, model preset, custom model name and effort a single question
 * is asked with, in the Home ask box's model menu terms. */
export interface ResearchQuestionChoice {
  adapter: string;
  preset: string;
  customModel: string;
  /** "" for the agent's default effort. */
  effort: string;
}

/** The menu choice for a launch choice: a model that is one of the agent's
 * presets selects that preset, any other model is the agent's Custom option
 * with that name, and no model selects the agent's first preset. */
export function researchQuestionChoiceFrom(launch: ResearchLaunchChoice): ResearchQuestionChoice {
  const presets = modelPresetsFor(launch.adapter);
  const model = launch.model;
  if (model === null) {
    return { adapter: launch.adapter, preset: presets[0], customModel: "", effort: launch.effort ?? "" };
  }
  if (model !== CUSTOM_MODEL && presets.includes(model)) {
    return { adapter: launch.adapter, preset: model, customModel: "", effort: launch.effort ?? "" };
  }
  return { adapter: launch.adapter, preset: CUSTOM_MODEL, customModel: model, effort: launch.effort ?? "" };
}

/** The launch choice a menu choice asks with, or null when its agent is not
 * listed or cannot run research. As in the Home ask box, Custom without a
 * name launches the agent's default model, and an effort the agent does not
 * offer falls back to its default. */
export function researchQuestionLaunch(
  adapters: AgentAdapterMetadata[],
  choice: ResearchQuestionChoice,
): ResearchLaunchChoice | null {
  const adapter = adapters.find((candidate) => candidate.id === choice.adapter);
  if (!adapter || !adapterCanLaunchResearch(adapter)) {
    return null;
  }
  const model = choice.preset === CUSTOM_MODEL ? choice.customModel.trim() || null : choice.preset;
  const effortOptions = researchEffortOptionsFor(choice.adapter);
  const effort =
    choice.effort && effortOptions?.some((option) => option.value === choice.effort) ? choice.effort : null;
  return { adapter: choice.adapter, model, effort };
}

/** The Home ask box's model options; the selected agent's Custom option, once
 * named, is labelled with the name (so the trigger shows it) and keeps
 * "Custom" as its detail. */
export function researchQuestionModelOptions(
  adapters: AgentAdapterMetadata[],
  choice: ResearchQuestionChoice,
): LauncherSelectOption[] {
  const customName = choice.customModel.trim();
  const customValue = researchModelChoiceValue(choice.adapter, CUSTOM_MODEL);
  return researchModelOptions(adapters).map((option) =>
    customName && option.value === customValue ? { ...option, label: customName, detail: "Custom" } : option,
  );
}

/** The model menu of the Home ask box (agent and model, with Effort as a
 * submenu, and Custom asking for a model name) as a compact control. The
 * choice is the caller's; nothing here changes the Home ask box. With
 * `anchor`, the menu opens from the caller's element (a note's follow-up
 * box's Ask segment) instead of a trigger of its own. */
export function ResearchQuestionModelPicker({
  adapters,
  choice,
  disabled = false,
  anchor,
  onChange,
}: {
  adapters: AgentAdapterMetadata[];
  choice: ResearchQuestionChoice;
  disabled?: boolean;
  /** The element that opens the menu, and the menu's open state. */
  anchor?: {
    ref: RefObject<HTMLElement | null>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
  onChange: (choice: ResearchQuestionChoice) => void;
}) {
  // The agent whose Custom option was chosen, while its model name dialog is open.
  const [customModelAdapter, setCustomModelAdapter] = useState<string | null>(null);
  const options = useMemo(() => researchQuestionModelOptions(adapters, choice), [adapters, choice]);
  const effortOptions = researchEffortOptionsFor(choice.adapter);
  const selectedEffort =
    effortOptions && effortOptions.some((option) => option.value === choice.effort) ? choice.effort : "";
  const menu = (
    <>
      <LauncherSelect
        value={researchModelChoiceValue(choice.adapter, choice.preset)}
        options={options}
        ariaLabel="Model"
        disabled={disabled}
        anchorRef={anchor?.ref}
        open={anchor?.open}
        onOpenChange={anchor?.onOpenChange}
        onChange={(value) => {
          const next = parseResearchModelChoice(value);
          // Custom asks for the model name first; Cancel keeps the current
          // choice.
          if (next.preset === CUSTOM_MODEL) {
            setCustomModelAdapter(next.adapter);
            return;
          }
          onChange({ ...choice, adapter: next.adapter, preset: next.preset });
        }}
        onReselect={(value) => {
          const next = parseResearchModelChoice(value);
          if (next.preset === CUSTOM_MODEL) setCustomModelAdapter(next.adapter);
        }}
        submenu={
          effortOptions
            ? {
                label: "Effort",
                ariaLabel: "Effort",
                value: selectedEffort,
                options: effortOptions,
                onChange: (effort) => onChange({ ...choice, effort }),
              }
            : undefined
        }
      />
      {customModelAdapter ? (
        <ResearchModelNameDialog
          agentLabel={adapters.find((candidate) => candidate.id === customModelAdapter)?.label ?? customModelAdapter}
          initialName={customModelAdapter === choice.adapter ? choice.customModel : ""}
          onClose={() => setCustomModelAdapter(null)}
          onSubmit={(name) => {
            onChange({ ...choice, adapter: customModelAdapter, preset: CUSTOM_MODEL, customModel: name });
            setCustomModelAdapter(null);
          }}
        />
      ) : null}
    </>
  );
  // An anchored menu renders only its portals, so it needs no box of its own.
  return anchor ? menu : <span className="research-question-model">{menu}</span>;
}
