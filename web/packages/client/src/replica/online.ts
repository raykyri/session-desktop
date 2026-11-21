// Online-only data the screens read beside the replica (02 §9.1): the model
// registry with the site's default model and effort (`models.list`, 03 K11,
// K15) and the weekly usage (`usage.get`, 03 K6). A member reads both from
// the server (`useOnlineData`); until an answer arrives, and for a viewer
// who is not a member, they come from here: the registry of
// `@session/shared`, and the fixture build's values.

import { payerFor } from "@session/mutators";
import { MODEL_REGISTRY, type ModelPayer, type ReasoningEffort } from "@session/shared";

import { currentReading, type UsageReading } from "../features/shell/usage.js";

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

/** The providers a member may add a key for (03 K4). */
export type KeyProvider = "anthropic" | "openai";

export interface OnlineData {
  models: readonly ModelOption[];
  defaultModel: string;
  defaultEffort: Effort;
  /** Null until known: the ring reads "unknown" and nothing is refused. */
  usage: UsageReading | null;
  /** The providers the member has a `valid` key for (`usage.get`). */
  keys: readonly KeyProvider[];
  /** What happens when included tokens run out (`usage.get`, 03 K7). */
  billing: "pause" | "key";
}

/** The provider whose key alone pays for `model`, or null when included
 * tokens may pay (03 K11): such a model runs only on the member's key. */
export function keyOnlyProvider(model: Pick<ModelOption, "payers">): KeyProvider | null {
  if (model.payers.includes("included")) return null;
  if (model.payers.includes("key:openai")) return "openai";
  return model.payers.includes("key:anthropic") ? "anthropic" : null;
}

/** Whether the member can run `model`: included tokens may pay, or the
 * member holds the key its payers name. */
export function modelPayable(
  model: Pick<ModelOption, "payers">,
  keys: readonly KeyProvider[],
): boolean {
  const provider = keyOnlyProvider(model);
  return provider === null ? model.payers.includes("included") : keys.includes(provider);
}

/** The model a composer runs on (02 §5): the tab's choice when the member
 * can run it, else the site default model, else the first model the member
 * can run. A key-only model whose key was removed falls back this way. */
export function composerModel(
  online: Pick<OnlineData, "models" | "defaultModel" | "keys">,
  chosen: string | null,
): ModelOption | undefined {
  const usable = (id: string | null) =>
    online.models.find((m) => m.id === id && modelPayable(m, online.keys));
  return (
    usable(chosen) ??
    usable(online.defaultModel) ??
    online.models.find((m) => modelPayable(m, online.keys)) ??
    online.models[0]
  );
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

/** `usage.get`'s answer, as far as the ring and the composer read it
 * (03 K5, K6, K11). */
export interface WeeklyUsage {
  allowance: number;
  used: number;
  resetAt: number;
  billing?: "pause" | "key";
  keys?: readonly { provider: KeyProvider; status: "valid" | "invalid" }[];
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
          keys: (usage.keys ?? [])
            .filter((key) => key.status === "valid")
            .map((key) => key.provider),
          billing: usage.billing ?? "pause",
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
    keys: [],
    billing: "pause",
  };
}

/**
 * Whether a run on `model` has no payer now (03 K8): the server's rule
 * (`payerFor`) over the member's `usage.get` reading, so the composer sends
 * no Ask, follow-up, Continue, Branch, Branch here, Look up or Run again
 * whose run the server would write `failed { why: "tokens" }`. False while
 * the reading is unknown, when its week has reset by `now` (the server's
 * clock; `currentReading`), and for a model the client does not know: the
 * server decides. A key-only model without its key is not offered
 * (`composerModel`).
 */
export function outOfTokens(
  online: Pick<OnlineData, "models" | "usage" | "keys" | "billing">,
  model: string,
  now: number,
): boolean {
  const entry = online.models.find((m) => m.id === model);
  const usage = currentReading(online.usage, now);
  if (!entry || usage === null) return false;
  const facts = {
    includedLeft: usage.used < usage.allowance,
    billing: online.billing,
    keys: online.keys,
  };
  return payerFor(entry.payers, facts) === "out_of_tokens";
}
