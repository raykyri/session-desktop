// Who pays for a run, and when it has to stop (`03-agents-and-research.md`
// K3, K8, K9, K10, L1).
//
// Every check reads the ledger including open rows (`ledger.ts`), so a
// member's concurrent runs see each other's spending as of their last
// checkpoint. The loop checks at every step boundary and at every ledger
// checkpoint (`loop.ts`); the dispatcher checks before an attempt starts
// (`dispatcher.ts`).

import type { PayerDecision, PayerFacts } from "@session/mutators";
import { payerFor } from "@session/mutators";
import type { ModelEntry } from "@session/shared";

import type { Config } from "../config.js";

import type { Ledger, Payer } from "./ledger.js";
import { weekOf } from "./ledger.js";
import type { BillLabel } from "./store.js";

/** The Usage page's choice for when included tokens run out (`03` K7). */
export type Billing = "pause" | "key";

/** The providers a member may add a key for (`03` K4). */
export type KeyProvider = "anthropic" | "openai";

/** A member's key opened for the duration of one provider call. `sealed` is
 * the stored value it was opened from: it identifies the key without the
 * plaintext, so a later check or a rejection compares `sealed`. */
export interface MemberKey {
  apiKey: string;
  sealed: string;
}

/** A member's allowance settings. M5b reads them from `user_limits`, the
 * billing setting and the stored keys (`03` K3, K4, K7). */
export interface Allowances {
  /** Included tokens per week: `SESSION_WEEKLY_TOKENS` unless the member has
   * an override. */
  weekly(userId: string): number;
  billing(userId: string): Billing;
  /** The sealed value of the member's `valid` key for `provider`, or null:
   * a status check that decrypts nothing (`03` K4, K8). */
  validKey(userId: string, provider: KeyProvider): string | null;
  /** The member's valid Anthropic key, opened for the duration of a call;
   * null without one. Never logged or stored by the caller. */
  anthropicKey(userId: string): MemberKey | null;
  /** The member's valid OpenAI key, for a key-only OpenAI model (`03` K11). */
  openaiKey(userId: string): MemberKey | null;
  /** A provider rejected the member's key for `provider` during a run
   * (`03` K4, E5): the stored key becomes `invalid` if its sealed value is
   * still `sealed`. Absent where no keys are stored. */
  keyRejected?(userId: string, provider: KeyProvider, sealed: string): void;
}

/** Every member on the configured allowance, billing `pause`, no keys: the
 * settings until M5b stores them. */
export function configAllowances(config: Pick<Config, "limits">): Allowances {
  return {
    weekly: () => config.limits.weeklyTokens,
    billing: () => "pause",
    validKey: () => null,
    anthropicKey: () => null,
    openaiKey: () => null,
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

/** Whether billing lets the asker's Anthropic key pay for `entry`: billing
 * is `key` and the model may be paid with the Anthropic key (its registry
 * payers, `03` K8, K9, K11). */
function keyBillingFor(deps: BudgetDeps, userId: string, entry: Pick<ModelEntry, "payers">) {
  return entry.payers.includes("key:anthropic") && deps.allowances.billing(userId) === "key";
}

/** The asker's Anthropic key, opened, when it may pay for `entry` now:
 * billing is `key`, the model may be paid with the Anthropic key and a
 * valid key is stored (`03` K8, K9). */
export function anthropicKeyFor(
  deps: BudgetDeps,
  userId: string,
  entry: Pick<ModelEntry, "payers">,
): MemberKey | null {
  return keyBillingFor(deps, userId, entry) ? deps.allowances.anthropicKey(userId) : null;
}

const KEY_PROVIDERS: readonly KeyProvider[] = ["anthropic", "openai"];

/** What the payer of a run is decided from (`03` K8): the member's
 * included tokens left this week, open ledger rows counted (K1), their
 * billing setting (K7) and the providers they hold a `valid` key for (K4).
 * Decrypts nothing. `pre` reads it when a write queues a run, and the
 * dispatcher again when it claims one (K10). */
export function payerFacts(deps: BudgetDeps, userId: string): PayerFacts {
  return {
    includedLeft: includedUsed(deps, userId) < deps.allowances.weekly(userId),
    billing: deps.allowances.billing(userId),
    keys: KEY_PROVIDERS.filter((provider) => deps.allowances.validKey(userId, provider) !== null),
  };
}

/**
 * The payer of an attempt about to start (`03` K8, K10): the rule `pre`
 * applied when the run was queued (`payerFor`), over the facts as they are
 * now. A run whose payer is now `out_of_tokens` ends `failed { why:
 * "tokens" }`, and one on a key-only model without its key `failed { why:
 * "key" }`, both without a provider call.
 */
export function payerAtStart(
  deps: BudgetDeps,
  userId: string,
  entry: Pick<ModelEntry, "payers">,
): PayerDecision {
  return payerFor(entry.payers, payerFacts(deps, userId));
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
  keyForNextStep(entry: Pick<ModelEntry, "payers">): MemberKey | null {
    if (!this.allowanceSpent()) {
      return null;
    }
    return anthropicKeyFor(this.#deps, this.#userId, entry);
  }

  /**
   * Whether the member's key may still pay for the next step of a run paid
   * by `payer` with the key sealed as `sealed` (`03` K4, K7): the stored key
   * for the provider is still `valid` with the same sealed value (not
   * removed, replaced or invalid), and for the Anthropic key billing is
   * still `key`. Always true for `included`. Decrypts nothing.
   */
  keyStillPays(payer: Payer, sealed: string | undefined): boolean {
    if (payer === "included") return true;
    const provider: KeyProvider = payer === "key:openai" ? "openai" : "anthropic";
    const stored = this.#deps.allowances.validKey(this.#userId, provider);
    if (stored === null || stored !== sealed) return false;
    return provider === "openai" || this.#deps.allowances.billing(this.#userId) === "key";
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
