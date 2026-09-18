// Provider failures, classified (`04-agent-runtime.md` §3.6,
// `05-run-lifecycle-and-streaming.md` §10).
//
// Two things depend on the class. The loop does: `rate_limited` re-queues with
// backoff instead of failing, everything else settles the node. And the user
// does: the message is what the document shows under a failed run, so it says
// what happened and what to do about it, without a status code.

import { APICallError } from "@ai-sdk/provider";

import { errorText } from "./mapper.js";

export type RunErrorClass =
  | "rate_limited"
  | "auth"
  | "content_filter"
  | "context_too_long"
  | "provider_unavailable"
  | "network"
  | "timeout"
  | "unknown";

export interface ClassifiedError {
  errorClass: RunErrorClass;
  /** What the document shows. */
  message: string;
  /** The provider's own words, for the log and `run_attempts.error_class`. */
  detail: string;
}

const CONTEXT_PATTERNS = [
  /context (?:length|window)/i,
  /token count/i,
  /too many tokens/i,
  /maximum .*tokens/i,
  /input is too long/i,
  /prompt is too long/i,
];

const UNAVAILABLE_PATTERNS = [
  /no endpoints found/i,
  /no allowed providers/i,
  /zdr/i,
  /data[_ ]collection/i,
  /model .* not found/i,
];

const NETWORK_PATTERNS = [
  /fetch failed/i,
  /socket hang up/i,
  /terminated/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /network/i,
  /stream closed/i,
];

const COPY: Record<RunErrorClass, string> = {
  rate_limited: "the model provider is rate limiting this deployment; the run will retry shortly",
  auth: "this deployment's credential for the model was rejected; an operator has to fix it",
  content_filter: "the model declined to answer this question; try rewording it or another model",
  context_too_long:
    "this thread has outgrown the model's context; start a new thread with the question",
  provider_unavailable:
    "no zero-retention provider was available for this model; try again or pick another model",
  network: "the connection to the model provider failed part-way through the answer",
  timeout: "the run took longer than this deployment allows and was stopped",
  unknown: "the model provider returned an error",
};

/** The class of one thrown provider error. */
export function classifyRunError(error: unknown): ClassifiedError {
  const detail = errorText(error);
  const classOf = (errorClass: RunErrorClass): ClassifiedError => ({
    errorClass,
    message: COPY[errorClass],
    detail,
  });
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429) {
      return classOf("rate_limited");
    }
    if (status === 401 || status === 403) {
      return classOf("auth");
    }
    if (status !== undefined && status >= 500) {
      return classOf("network");
    }
    if (CONTEXT_PATTERNS.some((pattern) => pattern.test(detail))) {
      return classOf("context_too_long");
    }
    if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))) {
      return classOf("provider_unavailable");
    }
    return classOf("unknown");
  }
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return classOf("context_too_long");
  }
  if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return classOf("provider_unavailable");
  }
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(detail))) {
    return classOf("network");
  }
  return classOf("unknown");
}

/** A `content-filter` finish reason, or Fable's `refusal` stop reason, is not
 * an exception: the request succeeded and the model declined
 * (`04-agent-runtime.md` §3.6). */
export function refusalError(rawFinishReason?: string): ClassifiedError {
  return {
    errorClass: "content_filter",
    message: COPY.content_filter,
    detail:
      rawFinishReason === undefined ? "content-filter" : `content-filter (${rawFinishReason})`,
  };
}

export function timeoutError(seconds: number): ClassifiedError {
  return {
    errorClass: "timeout",
    message: COPY.timeout,
    detail: `wall clock limit of ${seconds}s reached`,
  };
}

/** How long a re-queued attempt waits: 5 s, 20 s, 60 s, then the node fails
 * (`05-run-lifecycle-and-streaming.md` §8). */
export const RATE_LIMIT_BACKOFF_MS = [5_000, 20_000, 60_000] as const;

export const MAX_RATE_LIMIT_REQUEUES = RATE_LIMIT_BACKOFF_MS.length;

export function backoffFor(attemptsSoFar: number): number | null {
  return RATE_LIMIT_BACKOFF_MS[attemptsSoFar] ?? null;
}
