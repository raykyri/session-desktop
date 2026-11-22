// Validators shared by the client's forms and the mutators, so a form and the
// server accept the same values: channel names (`04` B1), handles (`04`
// §3.1), text bounds (`04` §10), look-up phrases and their prompt (`03` G2),
// and mentions (`01` C16).

import { spaces } from "@session/shared";
import { z } from "zod";

/** Handles no person may have: a signed-out caller's absent handle prints as
 * one of them, so a key or log id built from it never names a person. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["null", "undefined"]);

/** A handle as used in keys (`member:<space>:<handle>`): no ":". Every
 * account handle passes it; the mutators take it for a person named in an
 * input and for the actor. */
export const handleS = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine((h) => !RESERVED_HANDLES.has(h), "reserved");
export const isHandle = (u: string) => handleS.safeParse(u).success;

/** An account handle as a person chooses it at the profile step (`04` §3.1,
 * the mockup's rule): 3 to 20 of `a-z`, `0-9`, `.` and `_`. */
export const ACCOUNT_HANDLE_RE = /^[a-z0-9._]{3,20}$/;
export const accountHandleOk = (h: string) => ACCOUNT_HANDLE_RE.test(h) && isHandle(h);

/** A channel name as stored (`04` B1, `01` C14): a letter or digit, then 1 to
 * 29 letters, digits or "-". */
export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;

/** The channel name a person typed, as stored: trimmed, lower case, without
 * a leading "#"; or null when it is not a valid name. The New channel dialog
 * and `spaces.create` both use it. */
export function channelName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/^#/, "");
  return CHANNEL_NAME_RE.test(name) ? name : null;
}

/** Text bounds, in UTF-16 units as zod counts (`04` §10; the input schemas
 * refuse longer text with BAD_REQUEST, recorded). */
export const TEXT_MAX = {
  /** A channel's About. */
  about: spaces.SPACE_DESC_MAX,
  /** A removal's reason. */
  note: spaces.MODERATION_NOTE_MAX,
  /** A question, a post, a reply, a comment. */
  text: spaces.ASK_TEXT_MAX,
  /** The passage a branch or a look-up was started from. */
  quote: spaces.QUOTE_MAX,
  /** A look-up phrase. */
  look: spaces.LOOKUP_PHRASE_MAX,
} as const;

/** Text as stored: trimmed; null when it is empty or longer than `max`. */
export function boundedText(v: string, max: number): string | null {
  const s = v.trim();
  return s && v.length <= max ? s : null;
}

/** A look-up phrase (`03` G2): 1 to 4 words once the characters that are not
 * letters, combining marks or digits are trimmed from both ends, so a
 * selection must start and end on word boundaries; null otherwise.
 *
 * The `\p{L}`, `\p{M}` and `\p{N}` classes follow the Unicode version of
 * the JavaScript engine, so a browser and the server may trim a phrase with
 * a newly assigned character differently. That is accepted: the client's
 * prediction is replaced by the server's stored `look` and `q` when the write
 * is confirmed (rebase, `01` Y11; M1b review 8). */
export function lookPhrase(v: string): string | null {
  const s = v.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 ? words.join(" ") : null;
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/** Whether a look-up phrase is whole words of the passage it was selected in
 * (`03` G2: the selection starts and ends on word boundaries): it occurs in
 * `quote`, spaces taken as one, with no letter or digit right before or
 * after it. */
export function onWordBoundaries(phrase: string, quote: string): boolean {
  const q = quote.replace(/\s+/g, " ");
  for (let k = q.indexOf(phrase); k >= 0; k = q.indexOf(phrase, k + 1)) {
    const before = k > 0 ? q.charAt(k - 1) : "";
    const after = q.charAt(k + phrase.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}

/** The look-up prompt, version 1 (`03` G2, the mockup's text in
 * `addLookup`): `research.forkNode` stores it in `q` with `tpl: 1`; the
 * client shows the phrase. */
export const LOOKUP_PROMPT_V1 = (phrase: string) =>
  `Look up "${phrase}" as it is used in this answer. Describe what it refers to in two or three sentences, with a source.`;

/** A look-up's question as readers see it once it is opened as its own
 * thread (`03` G5): the phrase, without the instructions to the model. */
export const lookUpTitle = (phrase: string) => `Look up "${phrase}"`;

/** The handles a text mentions (`@handle`), once each, in order. Trailing
 * `.`, `_` and `-` are punctuation, not part of the handle ("@mona_",
 * "@otto-": M1b review 15). */
export function mentionsIn(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/(?:^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]{0,63})/g)) {
    const h = (m[1] ?? "").replace(/[._-]+$/, "");
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}
