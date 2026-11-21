// Provider failures, classified (`04-agent-runtime.md` §3.6,
// `05-run-lifecycle-and-streaming.md` §10).
//
// Error classification controls both retry behavior and user-facing copy.
// `rate_limited` errors re-queue the node with backoff; all other errors settle
// the node, and their mapped messages explain the failure in the document view.

import { APICallError } from "@ai-sdk/provider";
import { RUN_ERROR_COPY } from "@session/shared";

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

/** The copy of each class, shared with the client (`@session/shared`). */
const COPY: Readonly<Record<RunErrorClass, string>> = RUN_ERROR_COPY;

/** A refusal of the attempt's own input rather than a provider failure (an
 * attached image the model cannot read, or one that is gone). The document
 * shows its message as written. */
export class RunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunInputError";
  }
}

/** The class of one thrown provider error. */
export function classifyRunError(error: unknown): ClassifiedError {
  const detail = errorText(error);
  if (error instanceof RunInputError) {
    return { errorClass: "unknown", message: error.message, detail };
  }
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

/**
 * Whether a provider error says the key itself is rejected (`03` K4): a 401,
 * or a body naming Anthropic's `authentication_error` or OpenAI's
 * `invalid_api_key`. A 403 is a permission error on a key that still
 * authenticates, and is not a rejection.
 */
export function isKeyRejection(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode === 401) return true;
  if (error.statusCode === 403) return false;
  const body = `${error.responseBody ?? ""} ${error.message}`;
  return /authentication_error|invalid_api_key/.test(body);
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
