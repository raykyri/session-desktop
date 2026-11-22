// Answers a mutator gives when it refuses a write: the codes of the
// contract (`Spaces.SpaceErrorCode`, `01` Y2) with the mock's default
// messages (section 2) and the sync protocol's.

import type { Spaces } from "@session/shared";

/** The answer codes, the sync protocol's included:
 * - `UPGRADE_REQUIRED`: the client's protocol version is below the minimum
 *   (the client reloads).
 * - `STALE`: the record a decision acts on is no longer in the state the
 *   client saw (a thread edited since `base.rev`, a member admitted again
 *   since the decision was made).
 * - `CLOCK_SKEW`: the envelope's `clientTime` is more than a minute from the
 *   server's time. Not recorded; the error carries `serverTime`, and the
 *   client corrects its clock and sends the write again.
 * - `EXPIRED`: the write is too old to apply. Measured on the device's clock
 *   (`clientTime`), its mutation id, its `queuedAt` or a new id in its input
 *   is more than 4 days old or more than a minute in the future, or an
 *   online-only write's mutation id is more than a minute old. Recorded; the
 *   client drops the write and tells the person.
 * - `OUT_OF_ORDER`: `seq` is not the client's next one. Not recorded; the
 *   error carries `expectedSeq`.
 * - `WRONG_CLIENT`: the client id is unknown, expired, or bound to another
 *   user. Not recorded.
 * - `TOO_LARGE`: the envelope is over 256 KB as JSON. Not recorded. */
export type ErrorCode = Spaces.SpaceErrorCode;

/** An error answer. `message` is fixed per code and cause, so two answers
 * with the same cause are byte-identical. `serverTime` (milliseconds since
 * the epoch) comes with CLOCK_SKEW; `expectedSeq`, the seq the server takes
 * next from this client, with OUT_OF_ORDER. */
export interface ApiError {
  code: ErrorCode;
  message: string;
  issues?: string[];
  /** Why a PRECONDITION_FAILED was answered, where the client acts on it. */
  reason?: Spaces.SpaceRefusalReason;
  serverTime?: number;
  expectedSeq?: number;
}

/** The mock's default messages (section 2), and the sync protocol's. */
export const MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "The server didn’t accept this change: some of its data is missing or not valid.",
  UNAUTHORIZED: "Your sign-in expired. Sign in again.",
  FORBIDDEN: "You don't have permission to do this.",
  NOT_FOUND: "This no longer exists. Someone may have deleted it.",
  METHOD_NOT_SUPPORTED: "The server doesn’t support this request.",
  CONFLICT: "Someone else changed this item first.",
  PRECONDITION_FAILED: "This change isn’t possible in the item’s current state.",
  TOO_MANY_REQUESTS: "Too many requests from your account. Try again in a few minutes.",
  INTERNAL_SERVER_ERROR: "Something went wrong. Try again.",
  SERVICE_UNAVAILABLE: "Session is unavailable right now. Try again in a few minutes.",
  UPGRADE_REQUIRED: "Update Session.",
  STALE: "This changed after you opened it. Check it and try again.",
  CLOCK_SKEW: "Your device’s clock is off.",
  EXPIRED: "This change waited too long to be sent and wasn't saved.",
  OUT_OF_ORDER: "This change arrived out of order.",
  WRONG_CLIENT: "This device isn’t signed in to your account.",
  TOO_LARGE: "This change is too large to send.",
};

/** A refusal: a mutator stage throws it, and nothing the mutation wrote is
 * kept. Any other exception from a stage is a fault of the server
 * (INTERNAL_SERVER_ERROR, not recorded). */
export class Refusal extends Error {
  readonly code: ErrorCode;
  readonly issues: string[] | undefined;
  readonly reason: Spaces.SpaceRefusalReason | undefined;
  constructor(
    code: ErrorCode,
    message?: string,
    issues?: string[],
    reason?: Spaces.SpaceRefusalReason,
  ) {
    super(message ?? MESSAGES[code]);
    this.code = code;
    this.issues = issues;
    this.reason = reason;
  }
  toError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues ? { issues: this.issues } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}

export const refuse = (code: ErrorCode, message?: string, issues?: string[]) =>
  new Refusal(code, message, issues);

/** A channel invite link that does not work: unknown, used, revoked or
 * expired, or its channel frozen (`04` §9, B5). */
export const INVITE_LINK_DEAD =
  "This invite link no longer works. Ask the channel owner for a new one.";

/** The message of an input its schema refused (`04` §10): a text over its
 * bound names the bound; any other fault keeps BAD_REQUEST's default. */
export function inputMessage(
  issues: readonly { code: string; origin?: unknown; maximum?: unknown }[],
): string | undefined {
  const long = issues.find((x) => x.code === "too_big" && x.origin === "string");
  if (long === undefined) return undefined;
  // thousands grouped by hand: the package uses no locale formatting (U1)
  const max = String(long.maximum).replace(/\B(?=(\d{3})+$)/g, ",");
  return `This text is too long. Keep it to ${max} characters or fewer.`;
}
