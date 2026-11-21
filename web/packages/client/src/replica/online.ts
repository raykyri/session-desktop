// Online-only data the screens read beside the replica (02 §9.1): the model
// registry with the site's default model and effort (`models.list`, 03 K11,
// K15) and the weekly usage (`usage.get`, 03 K6). A member reads both from
// the server (`useOnlineData`); until an answer arrives, and for a viewer
// who is not a member, they come from here: the registry of
// `@session/shared`, and the fixture build's values.

import { MODEL_REGISTRY, type ModelPayer, type ReasoningEffort } from "@session/shared";

import type { UsageReading } from "../features/shell/usage.js";

export type Effort = ReasoningEffort;

/** Efforts from lowest to highest (02 §5). */
export const EFFORT_ORDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelOption {
  id: string;
  /** The full name, shown in the menu. */
  label: string;
  /** The short name, shown on the picker button. */
  short: string;
  /** The efforts the model accepts, lowest first. */
  efforts: readonly Effort[];
  /** Who may pay for a run on it (03 K11). */
  payers: readonly ModelPayer[];
  /** The model's provider, shown on the Site Admin page. */
  provider: string;
}

export interface OnlineData {
  models: readonly ModelOption[];
  defaultModel: string;
  defaultEffort: Effort;
  /** Null until known: the ring reads an unused allowance. */
  usage: UsageReading | null;
}

/** A model's short name: its label without the vendor word and the words
 * that carry a version ("Claude Fable 5.1" → "Fable", "GPT-5.6 Luna" →
 * "Luna", "Gemini 3.8 Flash" → "Gemini"; the mock's `SHORT`). */
export function shortModelName(label: string): string {
  const words = label.split(/\s+/).filter((w) => !/\d/.test(w) && w !== "Claude");
  return words[0] ?? label;
}

export function registryModels(): ModelOption[] {
  return MODEL_REGISTRY.map((m) => ({
    id: m.id,
    label: m.label,
    short: shortModelName(m.label),
    efforts: m.efforts,
    payers: m.payers,
    provider: m.provider,
  }));
}

/** `models.list`'s answer (03 K15). */
export interface ModelListing {
  models: readonly {
    id: string;
    label: string;
    provider: string;
    payers: readonly ModelPayer[];
    efforts: readonly Effort[];
  }[];
  defaultModel: string;
  defaultEffort: Effort;
}

/** `usage.get`'s answer, as far as the ring reads it (03 K5, K6). */
export interface WeeklyUsage {
  allowance: number;
  used: number;
  resetAt: number;
}

/**
 * The online data with the server's answers in: `models.list` sets the
 * models and the site defaults, `usage.get` the ring's reading. A missing
 * answer keeps `base`.
 */
export function withServerData(
  base: OnlineData,
  listing: ModelListing | undefined,
  usage: (WeeklyUsage & { readAt?: number }) | undefined,
): OnlineData {
  return {
    ...base,
    ...(listing
      ? {
          models: listing.models.map((m) => ({
            id: m.id,
            label: m.label,
            short: shortModelName(m.label),
            efforts: m.efforts,
            payers: m.payers,
            provider: m.provider,
          })),
          defaultModel: listing.defaultModel,
          defaultEffort: listing.defaultEffort,
        }
      : {}),
    ...(usage
      ? {
          usage: {
            used: usage.used,
            allowance: usage.allowance,
            resetsAt: usage.resetAt,
            readAt: usage.readAt,
          },
        }
      : {}),
  };
}

/** The highest effort `model` accepts that is not above `effort` (02 §5);
 * every model accepts `low`. */
export function stepDownEffort(effort: Effort, accepted: readonly Effort[]): Effort {
  const at = EFFORT_ORDER.indexOf(effort);
  for (let i = at; i >= 0; i--) {
    const candidate = EFFORT_ORDER[i];
    if (candidate !== undefined && accepted.includes(candidate)) return candidate;
  }
  return accepted[0] ?? "low";
}

export const effortLabel = (effort: Effort) => effort.charAt(0).toUpperCase() + effort.slice(1);

export function defaultOnlineData(): OnlineData {
  return {
    models: registryModels(),
    defaultModel: "gemini-flash",
    defaultEffort: "medium",
    usage: null,
  };
}
