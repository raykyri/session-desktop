import test from "ava";

import {
  MAX_ENCYCLOPEDIA_SLUG_CHARS,
  encyclopediaSlug,
  validateEncyclopediaSlug,
} from "../src/encyclopedia/slug.js";

// The cases the desktop kept in `src-tauri/fixtures/encyclopedia-slugs.json`,
// where the renderer and the backend each had their own slug function to keep
// in step. The web has one implementation; the cases still pin the grammar.
const SLUG_CASES: { term: string; slug: string }[] = [
  { term: "Daemon", slug: "daemon" },
  { term: "  Daniel Suarez ", slug: "daniel-suarez" },
  { term: "Freedom™ (2010)", slug: "freedom-2010" },
  { term: "C++ / Rust", slug: "c-rust" },
  { term: "Überlingen", slug: "überlingen" },
  { term: "X (Twitter)", slug: "x-twitter" },
  { term: "Claude 3 Opus", slug: "claude-3-opus" },
  { term: "---", slug: "" },
  { term: "", slug: "" },
  { term: "東京", slug: "東京" },
  // Combining vowel signs are alphabetic; a script that writes them cannot be
  // cut into dash-separated consonants.
  { term: "हिन्दी", slug: "हिन-दी" },
  { term: "עִבְרִית", slug: "עִבְרִית" },
];

test("terms slug to lowercase alphanumeric runs joined by dashes", (t) => {
  for (const { term, slug } of SLUG_CASES) {
    t.is(encyclopediaSlug(term), slug, JSON.stringify(term));
  }
});

test("slugs are capped in characters and never end on a dash", (t) => {
  t.is([...encyclopediaSlug("a".repeat(200))].length, MAX_ENCYCLOPEDIA_SLUG_CHARS);
  // A word boundary that would land the dash at the cap drops the dash with
  // the word it was joining.
  t.false(encyclopediaSlug(`${"a".repeat(79)} b`).endsWith("-"));
  t.is(encyclopediaSlug(`${"a".repeat(78)} b`), `${"a".repeat(78)}-b`);
});

test("validation accepts only what the slugger itself produces", (t) => {
  t.is(validateEncyclopediaSlug("daemon"), "daemon");
  t.is(validateEncyclopediaSlug("claude-3-opus"), "claude-3-opus");
  for (const invalid of ["", "Daemon", "../etc", "a b", "daemon-", "a--b"]) {
    t.throws(() => validateEncyclopediaSlug(invalid), {
      message: `Invalid slug '${invalid}': must contain only lowercase alphanumeric characters and hyphens.`,
    });
  }
});
