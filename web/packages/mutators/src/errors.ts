// Error codes and refusals. The codes are the spaces API's
// (`Spaces.SpaceErrorCode`) and the ones the sync protocol adds, as in
// `replica-proto/src/contract.ts`. A mutator refuses by throwing a `Refusal`;
// the engine turns any other exception into INTERNAL_SERVER_ERROR.

import type { Spaces } from "@session/shared";

import { canRead, redact, type Reader } from "./access.js";
import { keyOf, type StoredRecord } from "./records.js";

/** The spaces API's codes, and the sync protocol's:
 * - `UPDATE_REQUIRED`: the client's protocol version is below the minimum.
 * - `STALE`: the record a decision acts on is no longer in the state the
 *   client saw (its rev, or a member's admission id, differs).
 * - `CLOCK_SKEW`: the device's clock is more than a minute from the server's.
 * - `EXPIRED`: the write is too old to apply (its mutation id or a new id in
 *   its input is more than 4 days old on the device's clock, more than a
 *   minute in the future, or an online-only write's id is over a minute old).
 * - `OUT_OF_ORDER`: the envelope's seq is not the client's next one.
 * - `WRONG_CLIENT`: the client id is unknown, expired or another user's.
 * - `TOO_LARGE`: the envelope (or a device run's answer) is larger than the
 *   server takes. */
export type ErrorCode =
  | Spaces.SpaceErrorCode
  | "UPDATE_REQUIRED"
  | "STALE"
  | "CLOCK_SKEW"
  | "EXPIRED"
  | "OUT_OF_ORDER"
  | "WRONG_CLIENT"
  | "TOO_LARGE";

/** An error answer. `message` is fixed per code and cause, so two answers
 * with the same cause are equal. `retryAt` (ISO): on a limit's
 * TOO_MANY_REQUESTS, when the write can be sent again. `current` (STALE
 * only): the record the write acted on, as the actor may read it now
 * (`redact`), or null when they may no longer read it (phase 1b, Part 0
 * item 4). `reads` (STALE only): the keys of the records the answer is
 * about, the target first; a server half answers them again as `changes`
 * and stores only the keys with a recorded answer, never their text. */
export interface ApiError {
  code: ErrorCode;
  message: string;
  issues?: string[];
  retryAt?: string;
  current?: StoredRecord | null;
  reads?: string[];
}

/** The mock's default messages (its section 2), and the sync protocol's. */
export const MESSAGES: Readonly<Record<ErrorCode, string>> = {
  BAD_REQUEST: "The server didn’t accept this change: some of its data is missing or not valid.",
  UNAUTHORIZED: "Your sign-in expired. Sign in again.",
  FORBIDDEN: "You don’t have permission to do this.",
  NOT_FOUND: "The server has no record of this item. Someone may have deleted it.",
  METHOD_NOT_SUPPORTED: "The server doesn’t support this request.",
  CONFLICT: "Someone else changed this item first.",
  PRECONDITION_FAILED: "This change isn’t possible in the item’s current state.",
  TOO_MANY_REQUESTS: "Too many requests from your account. Try again in a minute.",
  INTERNAL_SERVER_ERROR: "The server had an error and didn’t save the change.",
  SERVICE_UNAVAILABLE: "The server is unavailable.",
  UPDATE_REQUIRED: "Update Session.",
  STALE: "This item changed after you saw it. Look at it again.",
  CLOCK_SKEW: "Your device’s clock is off.",
  EXPIRED: "This change waited too long to be sent, and wasn’t saved.",
  OUT_OF_ORDER: "This change arrived out of order.",
  WRONG_CLIENT: "This device isn’t signed in to your account.",
  TOO_LARGE: "This change is larger than the server takes.",
};

/** A refusal: a mutator stage throws it, and nothing the mutation staged is
 * kept. */
export class Refusal extends Error {
  readonly code: ErrorCode;
  readonly issues: string[] | undefined;
  readonly retryAt: string | undefined;
  /** STALE: the target as the actor reads it now, and the keys answered. */
  current: StoredRecord | null | undefined;
  reads: string[] | undefined;
  constructor(code: ErrorCode, message?: string, issues?: string[], retryAt?: string) {
    super(message ?? MESSAGES[code]);
    this.code = code;
    this.issues = issues;
    this.retryAt = retryAt;
  }
  toError(): ApiError {
    const e: ApiError = { code: this.code, message: this.message };
    if (this.issues) e.issues = [...this.issues];
    if (this.retryAt !== undefined) e.retryAt = this.retryAt;
    if (this.current !== undefined) e.current = this.current;
    if (this.reads !== undefined) e.reads = [...this.reads];
    return e;
  }
}

export const refuse = (code: ErrorCode, message?: string, issues?: string[], retryAt?: string) =>
  new Refusal(code, message, issues, retryAt);

/** BAD_REQUEST naming one input field. */
export const bad = (path: string, expected: string) =>
  refuse("BAD_REQUEST", undefined, [`input.${path}: expected ${expected}`]);

/** The one answer for a missing target and for a target the actor may not
 * read. */
export const notFound = () => refuse("NOT_FOUND");

/** STALE for a write whose target changed since the client read it:
 * `target` is the record as it is now (`redact`ed for the actor), and `more`
 * the keys of other records the answer is about (a hidden item's hide
 * record). */
export function stale(
  g: Reader,
  me: string,
  target: StoredRecord | null,
  more: string[] = [],
): Refusal {
  const e = refuse("STALE");
  e.current = target === null ? null : canRead(g, target, me) ? redact(g, target, me) : null;
  e.reads = [...(target === null ? [] : [keyOf(target)]), ...more];
  return e;
}
