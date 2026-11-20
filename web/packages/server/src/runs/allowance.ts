// Who pays for a run, and when it has to stop (`03-agents-and-research.md`
// K3, K8, K9, K10, L1).
//
// Every check reads the ledger including open rows (`ledger.ts`), so a
// member's concurrent runs see each other's spending as of their last
// checkpoint. The loop checks at every step boundary and at every ledger
// checkpoint (`loop.ts`); the dispatcher checks before an attempt starts
// (`dispatcher.ts`).

import type { ModelEntry } from "@session/shared";

import type { Config } from "../config.js";

import type { Ledger, Payer } from "./ledger.js";
import { weekOf } from "./ledger.js";
import type { BillLabel } from "./store.js";

/** The Usage page's choice for when included tokens run out (`03` K7). */
export type Billing = "pause" | "key";

/** A member's allowance settings. M5b reads them from `user_limits`, the
 * billing setting and the stored keys (`03` K3, K4, K7). */
export interface Allowances {
  /** Included tokens per week: `SESSION_WEEKLY_TOKENS` unless the member has
   * an override. */
  weekly(userId: string): number;
  billing(userId: string): Billing;
  /** The member's valid Anthropic key, for the duration of a call; null
   * without one. Never logged or stored by the caller. */
  anthropicKey(userId: string): string | null;
}

/** Every member on the configured allowance, billing `pause`, no keys: the
 * settings until M5b stores them. */
export function configAllowances(config: Pick<Config, "limits">): Allowances {
  return {
    weekly: () => config.limits.weeklyTokens,
    billing: () => "pause",
    anthropicKey: () => null,
  };
}

/** `03` K9, E5. */
export const OVERDRAFT_STOP_NOTE = "Stopped: this week's included tokens ran out.";
/** `03` L1, E5. */
export const RUN_CAP_NOTE = "Stopped at the run's token limit.";

export type StopReason = "overdraft" | "run_cap";

export function stopNote(reason: StopReason): string {
  return reason === "overdraft" ? OVERDRAFT_STOP_NOTE : RUN_CAP_NOTE;
}

export interface BudgetDeps {
  ledger: Ledger;
  allowances: Allowances;
  limits: Pick<Config["limits"], "overdraftTokens" | "runMaxTokens">;
  now: () => number;
}

/** The member's counted included tokens this week, open rows counted. */
export function includedUsed(deps: BudgetDeps, userId: string): number {
  return deps.ledger.includedUsage(userId, weekOf(deps.now()));
}

/** Whether the asker's Anthropic key may pay for `entry` now: the allowance
 * is spent, billing is `key`, the model is an Anthropic model and a valid
 * key is stored (`03` K8, K9). Returns the key. */
export function anthropicKeyFor(
  deps: BudgetDeps,
  userId: string,
  entry: Pick<ModelEntry, "provider">,
): string | null {
  if (entry.provider !== "anthropic" || deps.allowances.billing(userId) !== "key") {
    return null;
  }
  return deps.allowances.anthropicKey(userId);
}

/**
 * The payer of an attempt about to start (`03` K8, K10): `key:openai` stays
 * as it is; otherwise `included` while included tokens are left,
 * `key:anthropic` when they are spent and the asker's key may pay, `none`
 * otherwise. A run with `none` ends `failed { why: "tokens" }` without a
 * provider call.
 */
export function payerAtStart(
  deps: BudgetDeps,
  userId: string,
  entry: Pick<ModelEntry, "provider">,
  requested: Payer,
): Payer | "none" {
  if (requested === "key:openai") {
    return requested;
  }
  if (includedUsed(deps, userId) < deps.allowances.weekly(userId)) {
    return "included";
  }
  return anthropicKeyFor(deps, userId, entry) === null ? "none" : "key:anthropic";
}

/** The limits one attempt checks while it runs. */
export class RunBudget {
  readonly #deps: BudgetDeps;
  readonly #userId: string;
  readonly #runId: string;
  readonly #attempt: number;

  constructor(deps: BudgetDeps, scope: { userId: string; runId: string; attempt: number }) {
    this.#deps = deps;
    this.#userId = scope.userId;
    this.#runId = scope.runId;
    this.#attempt = scope.attempt;
  }

  /** True once the member's included usage reached the allowance. */
  allowanceSpent(): boolean {
    return includedUsed(this.#deps, this.#userId) >= this.#deps.allowances.weekly(this.#userId);
  }

  /** The asker's Anthropic key when the next step of an `included` run on
   * `entry` should move to it (`03` K9); null to stay on included tokens,
   * on overdraft once the allowance is spent. */
  keyForNextStep(entry: Pick<ModelEntry, "provider">): string | null {
    if (!this.allowanceSpent()) {
      return null;
    }
    return anthropicKeyFor(this.#deps, this.#userId, entry);
  }

  /**
   * Why the attempt has to stop now, or null. The run's token cap counts
   * every payer (`03` L1); the overdraft limit stops only calls paid with
   * included tokens, once the member's included usage reaches the allowance
   * plus `SESSION_OVERDRAFT_TOKENS` (`03` K9).
   */
  stopReason(payer: Payer): StopReason | null {
    if (this.#deps.ledger.runTokens(this.#runId, this.#attempt) >= this.#deps.limits.runMaxTokens) {
      return "run_cap";
    }
    if (payer !== "included") {
      return null;
    }
    const limit = this.#deps.allowances.weekly(this.#userId) + this.#deps.limits.overdraftTokens;
    return includedUsed(this.#deps, this.#userId) >= limit ? "overdraft" : null;
  }
}

/** The run record's `bill` from the payers its calls used (`03` K9). */
export function billLabel(payers: ReadonlySet<Payer>): BillLabel | null {
  if (payers.size === 0) {
    return null;
  }
  if (payers.has("included") && payers.has("key:anthropic")) {
    return "included+key:anthropic";
  }
  if (payers.has("key:openai")) {
    return "key:openai";
  }
  return payers.has("key:anthropic") ? "key:anthropic" : "included";
}
