// Row identifiers. ULIDs rather than UUIDs because every ordering in the
// domain is `(created_at, id)` (`docs/02-domain-model-and-database.md` §5.1):
// a ULID's first 48 bits are the millisecond timestamp, so ids minted in one
// millisecond still sort in creation order and a keyset cursor over
// `(created_at, id)` never ties ambiguously.

import { monotonicFactory } from "ulid";

const nextUlid = monotonicFactory();

/** Longest id the repositories accept. A ULID is 26 characters; the slack is
 * for ids minted elsewhere (invite codes). */
export const MAX_ID_LENGTH = 64;

/** A new monotonic ULID. Uppercase Crockford base32, as the spec defines. */
export function newId(): string {
  return nextUlid();
}

/** Whether `value` is usable as a row id: non-empty, bounded, and free of the
 * control characters and whitespace that would make a log line or a URL
 * ambiguous. */
export function isId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ID_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** {@link isId} as an assertion, with the message the tRPC layer surfaces. */
export function validateId(value: string, what = "id"): string {
  if (!isId(value)) {
    throw new Error(`${what} is not a valid identifier`);
  }
  return value;
}
