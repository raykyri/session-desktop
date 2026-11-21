// What a run's ending says (`03-agents-and-research.md` §1, E5;
// `02-client-app.md` §3.3): the copy of each provider error class, which the
// server classifies (`server/src/runs/errors.ts`) and the client shows for a
// run that ended `failed { why: "error", cls }`, and the copy of the other
// `fail.why` values.

import { OUT_OF_TOKENS_TEXT as SPACES_OUT_OF_TOKENS_TEXT } from "../schemas/spaces.js";
import type { RunFailure } from "../types/spaces.js";

/** The provider error classes of `runErrorClassSchema`, and `rate_limited`,
 * which the server re-queues rather than stores. */
export type RunErrorCopyClass =
  | "rate_limited"
  | "auth"
  | "content_filter"
  | "context_too_long"
  | "provider_unavailable"
  | "network"
  | "timeout"
  | "unknown";

export const RUN_ERROR_COPY: Readonly<Record<RunErrorCopyClass, string>> = {
  rate_limited: "The model provider is rate limiting this deployment. The run will retry shortly.",
  auth: "Provider authentication failed for this model. Please contact an administrator.",
  content_filter:
    "The model declined to answer this question. Rephrase the question or select another model.",
  context_too_long: "Context window limit exceeded. Please start a new thread for this question.",
  provider_unavailable:
    "No zero-retention provider is available for this model. Try again or select another model.",
  network: "The connection to the model provider was interrupted before the answer finished.",
  timeout:
    "The run exceeded the maximum duration allowed by this Session instance and was stopped.",
  unknown: "The model provider returned an error.",
};

/** `03` K8: the toast of an ask sent with no payer, and the reason of a run
 * that ended `tokens`. */
export const OUT_OF_TOKENS_TEXT = SPACES_OUT_OF_TOKENS_TEXT;

/** The reason a failed run shows, by `fail.why`. */
export function runFailureText(fail: Pick<RunFailure, "why" | "cls">): string {
  switch (fail.why) {
    case "tokens":
      return OUT_OF_TOKENS_TEXT;
    case "key":
      return "The API key for this run was rejected or removed. Check your keys in Usage.";
    case "rate":
      return "The model provider is rate limiting this deployment. Try again in a minute.";
    case "access":
      return "You can no longer read this channel, so the ask did not run.";
    case "interrupted":
      return "The run was interrupted.";
    case "stopped":
      return "Stopped.";
    case "error":
      return RUN_ERROR_COPY[fail.cls ?? "unknown"];
  }
}
