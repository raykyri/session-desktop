// Repository errors to tRPC codes (`03-api-and-events.md` §1).
//
// The repositories throw plain `Error`s whose messages are the user-facing
// copy the desktop showed. Rather than give every repository an error class,
// the mapping is one table here: the messages are asserted on in the database
// tests, so a rename cannot slip through silently.

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";

type Code = TRPC_ERROR_CODE_KEY;

const RULES: readonly { pattern: RegExp; code: Code }[] = [
  { pattern: / was not found$/, code: "NOT_FOUND" },
  { pattern: /^no account with the GitHub login/, code: "NOT_FOUND" },
  // A foreign id in a reorder is the same answer as an absent one (`06` §4).
  { pattern: /is not in this account$/, code: "NOT_FOUND" },
  // Optimistic concurrency and slot conflicts.
  { pattern: /the research response changed/, code: "CONFLICT" },
  { pattern: /changed while/, code: "CONFLICT" },
  { pattern: /is stale; refresh/, code: "CONFLICT" },
  { pattern: /already has an inline follow-up/, code: "CONFLICT" },
  { pattern: /already exists$/, code: "CONFLICT" },
  { pattern: /already finished as/, code: "CONFLICT" },
  { pattern: /belongs to a different answer/, code: "CONFLICT" },
  { pattern: /contains a duplicate/, code: "CONFLICT" },
  // Preconditions on the run state machine and on archived content.
  { pattern: /^only /, code: "PRECONDITION_FAILED" },
  { pattern: /^restore archived /, code: "PRECONDITION_FAILED" },
  { pattern: /^cancel (this|the) /, code: "PRECONDITION_FAILED" },
  { pattern: /require a completed parent/, code: "PRECONDITION_FAILED" },
  { pattern: /cannot be removed$/, code: "PRECONDITION_FAILED" },
  { pattern: /remove the whole thread instead/, code: "PRECONDITION_FAILED" },
];

/** Everything else a repository rejects is the caller sending something the
 * invariants refuse: an empty prompt, an oversized document, a bad anchor. */
const FALLBACK: Code = "BAD_REQUEST";

export function trpcCodeForRepoError(message: string): Code {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      return rule.code;
    }
  }
  return FALLBACK;
}

/**
 * Runs a repository call and translates its failure. A `TRPCError` thrown by
 * the caller's own checks passes through untouched, so a procedure can mix
 * both without wrapping each line.
 */
export function repo<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new TRPCError({
        code: trpcCodeForRepoError(error.message),
        message: error.message,
        cause: error,
      });
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: String(error) });
  }
}

/** `NOT_FOUND` for a row the user does not own or that does not exist — the
 * same answer either way, so a foreign id is never an existence oracle
 * (`06-auth-and-users.md` §4). */
export function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message });
  }
  return value;
}
