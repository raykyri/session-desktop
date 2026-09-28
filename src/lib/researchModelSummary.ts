import { findAgentUiAdapter } from "../adapters";
import {
  CUSTOM_MODEL,
  formatLauncherModelLabel,
  modelPresetsFor,
} from "./launcherModels";

function adapterDisplayLabel(adapter: string): string {
  if (!adapter) return "";
  return findAgentUiAdapter(adapter)?.label ?? formatLauncherModelLabel(adapter, adapter);
}

/** Preset names like Fable/Opus. Product ids (`gpt-5.6-sol`) and custom
 * slugs are omitted so the line can fall back to just the adapter. */
function humanReadableModelName(adapter: string, model?: string | null): string | null {
  if (!model || model === CUSTOM_MODEL) return null;
  if (!modelPresetsFor(adapter).includes(model)) return null;
  const label = formatLauncherModelLabel(adapter, model);
  if (/[\d._-]/.test(label)) return null;
  return label;
}

/** The model that answered a thread's root prompt, as "Claude Fable" or just
 * "Claude" when the model id has no preset name. Empty for unknown adapters. */
export function formatResearchModelSummary(
  adapter: string,
  model?: string | null,
  origin?: string | null,
): string {
  if (origin === "imported") return "Imported";
  const adapterLabel = adapterDisplayLabel(adapter);
  const modelName = humanReadableModelName(adapter, model);
  if (adapterLabel && modelName) return `${adapterLabel} ${modelName}`;
  return adapterLabel;
}
