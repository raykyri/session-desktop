// Encyclopedia slugs. A term maps to one page per workspace, and the slug is
// the page's key: `(workspaceId, slug)` in the database and the `/e/$slug`
// route. Client and server derive it from the same function here, so a term
// clicked in a research answer resolves to the page the server stored.
//
// Ported from the desktop `src/lib/encyclopedia.ts` and its backend mirror
// `src-tauri/src/encyclopedia.rs` (`encyclopedia_slug`, `validate_slug`),
// which had to be kept in step by hand; the web has one implementation.

export const MAX_ENCYCLOPEDIA_SLUG_CHARS = 80;

/** Rust's `char::is_alphanumeric()`, which is `is_alphabetic() ||
 * is_numeric()`: the Alphabetic derived property (not just the letter
 * categories) plus every numeric category. `\p{L}` alone would drop the
 * combining vowel signs that carry Devanagari and pointed Hebrew, cutting
 * those terms into dash-separated consonants. */
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

/** Lowercase alphanumeric runs joined by single dashes, capped in characters. */
export function encyclopediaSlug(term: string): string {
  let slug = "";
  let count = 0;
  let pendingDash = false;
  for (const ch of term.trim().toLowerCase()) {
    if (ALPHANUMERIC.test(ch)) {
      if (pendingDash && slug) {
        if (count + 1 >= MAX_ENCYCLOPEDIA_SLUG_CHARS) break;
        slug += "-";
        count += 1;
      }
      pendingDash = false;
      if (count >= MAX_ENCYCLOPEDIA_SLUG_CHARS) break;
      slug += ch;
      count += 1;
    } else {
      pendingDash = true;
    }
  }
  return slug;
}

/** A slug that arrives from a client is a lookup key, so it must be exactly
 * what `encyclopediaSlug` produces: no separators, no traversal, no case.
 * Returns the slug so it can be used inline; throws otherwise. */
export function validateEncyclopediaSlug(slug: string): string {
  if (!slug || encyclopediaSlug(slug) !== slug) {
    throw new Error(
      `Invalid slug '${slug}': must contain only lowercase alphanumeric characters and hyphens.`,
    );
  }
  return slug;
}
