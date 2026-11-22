// The model registry as members and site admins read it, and the site's
// default model and default effort (`03-agents-and-research.md` K11, K12,
// K15; decision P11; ADR-23).
//
// The two settings choose only where a composer starts: `pre` and `run`
// never read them (K13), so prediction is unaffected and a queued run keeps
// its model and effort when an admin changes them.

import type { SessionDatabase } from "@session/db";
import { siteSettings } from "@session/db";
import type {
  ModelEntry,
  ModelPayer,
  ModelProvider,
  ReasoningEffort,
  SiteEffort,
} from "@session/shared";
import { DEFAULT_MODEL_ID, isSiteEffort, payableWithIncluded } from "@session/shared";
import { TRPCError } from "@trpc/server";

import type { Logger } from "../logger.js";

/** One registry entry as `models.list` returns it: no prices and no
 * descriptions (K15). */
export interface ListedModel {
  id: string;
  label: string;
  provider: ModelProvider;
  payers: readonly ModelPayer[];
  efforts: readonly ReasoningEffort[];
}

export interface ModelListing {
  models: ListedModel[];
  defaultModel: string;
  defaultEffort: SiteEffort;
}

export function listedModel(entry: ModelEntry): ListedModel {
  return {
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    payers: [...entry.payers],
    efforts: [...entry.efforts],
  };
}

/** The registry's own default: `DEFAULT_MODEL_ID` when it is listed and
 * payable with included tokens, else the first entry that is. */
function registryDefault(registry: readonly ModelEntry[]): ModelEntry | null {
  const preferred = registry.find((entry) => entry.id === DEFAULT_MODEL_ID);
  if (preferred && payableWithIncluded(preferred)) return preferred;
  return registry.find(payableWithIncluded) ?? null;
}

/**
 * The site's default model and effort (K15). An unset model reads as the
 * registry's default. A stored model that is no longer a registry entry
 * payable with included tokens (a deploy removed it) reads the same, and the
 * stored value is cleared, so the registry's default holds until an admin
 * sets another. An unset effort reads as the default model's own
 * `defaultEffort` (the launch seed), `medium` when that is not one of the
 * four; a stored effort outside the four is cleared the same way.
 */
export function readSiteDefaults(
  db: SessionDatabase,
  registry: readonly ModelEntry[],
): { defaultModel: string; defaultEffort: SiteEffort } {
  const stored = siteSettings.get(db, "default_model");
  const storedModel = registry.find((entry) => entry.id === stored && payableWithIncluded(entry));
  if (stored !== undefined && storedModel === undefined) {
    siteSettings.clear(db, "default_model");
  }
  const model = storedModel ?? registryDefault(registry);
  const storedEffort = siteSettings.get(db, "default_effort");
  if (storedEffort !== undefined && !isSiteEffort(storedEffort)) {
    siteSettings.clear(db, "default_effort");
  }
  const seedEffort = model?.defaultEffort;
  return {
    defaultModel: model?.id ?? DEFAULT_MODEL_ID,
    defaultEffort: isSiteEffort(storedEffort)
      ? storedEffort
      : isSiteEffort(seedEffort)
        ? seedEffort
        : "medium",
  };
}

export function modelListing(db: SessionDatabase, registry: readonly ModelEntry[]): ModelListing {
  return { models: registry.map(listedModel), ...readSiteDefaults(db, registry) };
}

interface AdminWrite {
  db: SessionDatabase;
  registry: readonly ModelEntry[];
  logger: Logger;
  adminId: string;
  now: number;
}

/** `admin.models.setDefault`: a registry entry payable with included tokens,
 * else `BAD_REQUEST`. The default effort is left as it is. */
export function setDefaultModel(write: AdminWrite, model: string): string {
  const entry = write.registry.find((candidate) => candidate.id === model);
  if (!entry) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That model is no longer available. Reload to see the current list.",
    });
  }
  if (!payableWithIncluded(entry)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A model that runs only on a member's own key cannot be the default.",
    });
  }
  siteSettings.set(write.db, "default_model", entry.id, write.adminId, write.now);
  write.logger.info({ adminId: write.adminId, model: entry.id }, "default model set");
  return entry.id;
}

/** `admin.models.setDefaultEffort`: low, medium, high or max, else
 * `BAD_REQUEST`. Not checked against the default model: a composer steps an
 * effort its model does not accept down (K12). */
export function setDefaultEffort(write: Omit<AdminWrite, "registry">, effort: string): SiteEffort {
  if (!isSiteEffort(effort)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The default effort is low, medium, high or max.",
    });
  }
  siteSettings.set(write.db, "default_effort", effort, write.adminId, write.now);
  write.logger.info({ adminId: write.adminId, effort }, "default effort set");
  return effort;
}
