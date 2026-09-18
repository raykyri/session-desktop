// Repository errors to tRPC codes (`03-api-and-events.md` §1).
//
// The repositories throw plain `Error`s whose messages are the user-facing
// copy the desktop showed. Rather than give every repository an error class,
// the mapping is one table here: the messages are asserted on in the database
// tests, so a rename cannot slip through silently.
//
// Type first, message second. A `SqliteError` — a full volume, a corrupt page,
// a busy timeout — has a message written for a DBA and matches none of the
// patterns below; answering `BAD_REQUEST` with that message blames the caller
// for the server's failure, hands out the schema, and leaves the one class of
// error worth paging on indistinguishable from a typo in a form. Anything the
// table does not recognise is the server's fault until something says
// otherwise, and `app.ts` logs it with the request id.

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";

type Code = TRPC_ERROR_CODE_KEY;

const RULES: readonly { pattern: RegExp; code: Code }[] = [
  { pattern: / was not found$/, code: "NOT_FOUND" },
  { pattern: /^no account with the GitHub login/, code: "NOT_FOUND" },
  // A foreign id in a reorder is the same answer as an absent one (`06` §4).
  { pattern: /is not in this account$/, code: "NOT_FOUND" },
  { pattern: /is not in the requested sidebar section$/, code: "NOT_FOUND" },
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

/**
 * The caller sending something the invariants refuse: an empty prompt, an
 * oversized document, a bad anchor. These are deliberate refusals whose
 * messages are written to be read by a user, which is why they are recognised
 * by their text.
 */
const REFUSAL: Code = "BAD_REQUEST";

/** No rule matched and nothing about the error says it was deliberate. */
const UNCLASSIFIED: Code = "INTERNAL_SERVER_ERROR";

/** What a client is told about a failure that was not meant to happen. The
 * real message goes to the log with the request id, not over the wire: a
 * driver error names tables and columns. */
export const INTERNAL_MESSAGE = "An internal server error occurred. Please try again.";

/**
 * Errors thrown by the runtime or the driver rather than by a repository's own
 * check. `better-sqlite3` raises `SqliteError` with a `SQLITE_*` code, and a
 * programming mistake raises one of the built-in error classes; neither is
 * something the caller could have sent differently.
 */
export function isInfrastructureError(error: Error): boolean {
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) {
    return true;
  }
  if (error.name === "SqliteError" || error.name === "DatabaseError") {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_");
}

/** The message table alone. A message nothing recognises is `null` rather than
 * a guess, so the caller can tell "deliberate refusal" from "unclassified". */
export function matchRepoErrorMessage(message: string): Code | null {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      return rule.code;
    }
  }
  return null;
}

export function trpcCodeForRepoError(message: string): Code {
  return matchRepoErrorMessage(message) ?? REFUSAL;
}

/** The code for a thrown value: its type first, then its message. */
export function trpcCodeForError(error: unknown): Code {
  if (!(error instanceof Error)) {
    return UNCLASSIFIED;
  }
  if (isInfrastructureError(error)) {
    return UNCLASSIFIED;
  }
  return matchRepoErrorMessage(error.message) ?? REFUSAL;
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
    const code = trpcCodeForError(error);
    const message = error instanceof Error ? error.message : String(error);
    throw new TRPCError({
      code,
      // The repository messages are the copy a user reads; an unclassified
      // failure's message is not, and goes to the log instead.
      message: code === UNCLASSIFIED ? INTERNAL_MESSAGE : message,
      ...(error instanceof Error ? { cause: error } : {}),
    });
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
