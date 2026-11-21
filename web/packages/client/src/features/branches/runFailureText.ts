// What a failed run says (02 §3.3; 03 §1, K4, K8, E5), by who reads it. The
// asker reads what happened to their own allowance or key and what they can
// do; every other reader reads the same facts about the run's author, with
// nothing to do. `error`, `interrupted` and `stopped` read the same for
// everyone (`runFailureText` of `@session/shared`).

import { NO_KEY_TEXT, type RunRec } from "@session/mutators";
import { API_KEY_PROVIDER_INFO, runFailureText } from "@session/shared";

import { outOfTokensText } from "../usage/usageText.js";

export interface FailureView {
  /** The viewer asked: the run is theirs. */
  asker: boolean;
  /** For the asker: whether nothing can pay for a run on the run's model now
   * (`outOfTokens` over the current reading). */
  outOfTokens: boolean;
  /** The current reading's reset, ms; null when unknown. */
  resetAt: number | null;
  /** For tests; absent, the viewer's zone. */
  timeZone?: string;
}

/** The asker's tokens copy for a run that failed `tokens` before the
 * current allowance or a key could pay (03 K10: Run again starts it). */
export const TOKENS_PAST_TEXT =
  "This ask did not run: included tokens had run out. Run again to start it.";
export const TOKENS_OTHER_TEXT = "This ask did not run: its author had no included tokens left.";
export const KEY_OTHER_TEXT = "This run stopped: its author's API key could not be used.";
export const ACCESS_OTHER_TEXT =
  "This ask did not run: its author could no longer read this channel.";
export const RATE_OTHER_TEXT = "The model provider is rate limiting this deployment.";
/** The asker's key copy for a record written without `detail`. */
export const KEY_TEXT =
  "The API key for this run was rejected or removed. Check your keys in Usage.";

/** The provider of the member's key a run was billed to, from its payer or
 * its bill; null when neither names one. */
function keyProviderOf(run: Pick<RunRec, "pay" | "bill">): "anthropic" | "openai" | null {
  for (const payer of [run.pay, run.bill])
    if (payer === "key:openai") return "openai";
    else if (payer === "key:anthropic" || payer === "included+key:anthropic") return "anthropic";
  return null;
}

/** The asker's copy of a `key` failure, by its `detail` (03 K4, K11, E5). */
export function keyFailureText(run: Pick<RunRec, "pay" | "bill" | "fail">): string {
  const provider = keyProviderOf(run);
  const name = provider === null ? null : API_KEY_PROVIDER_INFO[provider].name;
  const yourKey = name === null ? "Your API key" : `Your ${name} key`;
  switch (run.fail?.detail) {
    case "key_only":
      return NO_KEY_TEXT;
    case "key_unset":
      return `No valid ${name === null ? "API" : name} key was set when this run started. Add a key in Usage.`;
    case "key_changed":
      return `${yourKey} was removed, replaced or marked invalid, or billing stopped using it, during this run. Check your keys in Usage.`;
    case "key_rejected":
      return `${name ?? "The provider"} rejected your API key, and it is now marked Invalid. Add a working key in Usage.`;
    case "key_forbidden":
      return `${name ?? "The provider"} refused your API key permission for this request. The key is still valid; check its permissions in your ${name ?? "provider"} account.`;
    case undefined:
      return KEY_TEXT;
  }
}

/** The reason a failed run shows to `view`'s reader. */
export function failedRunText(
  run: Pick<RunRec, "pay" | "bill" | "fail">,
  view: FailureView,
): string {
  const fail = run.fail ?? { why: "error" as const, at: null, cls: "unknown" as const };
  switch (fail.why) {
    case "tokens":
      if (!view.asker) return TOKENS_OTHER_TEXT;
      return view.outOfTokens ? outOfTokensText(view.resetAt, view.timeZone) : TOKENS_PAST_TEXT;
    case "key":
      return view.asker ? keyFailureText(run) : KEY_OTHER_TEXT;
    case "access":
      return view.asker ? runFailureText(fail) : ACCESS_OTHER_TEXT;
    case "rate":
      return view.asker ? runFailureText(fail) : RATE_OTHER_TEXT;
    default:
      return runFailureText(fail);
  }
}
