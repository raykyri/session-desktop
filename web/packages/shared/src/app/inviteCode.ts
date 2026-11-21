// Account invite codes and handles (plan `04` §3.1, §3.2).
//
// A code is `SESS-XXXX-XX`: six characters from a 32-character alphabet
// without `0`, `O`, `1` and `I`, so 30 random bits (decision S2). The server
// stores only the SHA-256 of the canonical form; the client and the server
// both read a typed code, a pasted link (`…/i#<code>`) or the older path
// form (`…/i/<code>/`) through `parseInviteCode`.

/** The characters a code is drawn from (the mockup's `newCode`). */
export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Random characters in a code: 6 × 5 bits = 30 bits. */
export const INVITE_CODE_LENGTH = 6;

const PREFIX = "SESS";

const BODY = new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

/** `SESS-` followed by the six characters, split 4 and 2. */
export function formatInviteCode(body: string): string {
  return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * The canonical code (`SESS-9TQ2-X8`) in `input`, or null when there is none.
 *
 * Accepts the code itself in any letter case, with or without spaces and
 * dashes, and a full link: everything up to the last `#` or `/` is dropped
 * (trailing slashes first), as the mockup's code field does.
 */
export function parseInviteCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 512) return null;
  let text = input.trim().replace(/\/+$/u, "");
  const cut = Math.max(text.lastIndexOf("#"), text.lastIndexOf("/"));
  if (cut >= 0) text = text.slice(cut + 1);
  let compact = text.toUpperCase().replace(/[\s-]+/gu, "");
  if (compact.startsWith(PREFIX)) compact = compact.slice(PREFIX.length);
  return BODY.test(compact) ? formatInviteCode(compact) : null;
}

/** The path of an account invite link; the code is in the fragment. */
export const ACCOUNT_INVITE_PATH = "/i";

/** `<origin>/i#<code>` (04 §3.2). */
export function accountInviteLink(origin: string, code: string): string {
  return `${origin}${ACCOUNT_INVITE_PATH}#${code}`;
}

/** A Session handle: 3 to 20 lowercase letters, digits, dots or
 * underscores (04 §3.1, the mockup's rule). */
export const ACCOUNT_HANDLE_PATTERN = /^[a-z0-9._]{3,20}$/u;

export function isAccountHandle(value: string): boolean {
  return ACCOUNT_HANDLE_PATTERN.test(value);
}

/** Longest display name the profile step accepts. */
export const DISPLAY_NAME_MAX_LENGTH = 50;

/** The display name as stored: control and format characters removed,
 * whitespace runs collapsed, trimmed, cut to the maximum length. Answers ""
 * for a name with nothing left. */
export function cleanDisplayName(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, DISPLAY_NAME_MAX_LENGTH);
}
