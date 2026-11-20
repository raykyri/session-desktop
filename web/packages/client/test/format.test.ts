// Phase 2 review round 1 (the comparison with the mockup): a feed row's
// summary and a search snippet are Markdown as plain text, and an
// underscore inside a word is not markup.

import test from "ava";

import { plainText } from "../src/data/format.js";
import { summaryOf } from "../src/data/spaces.js";

test("emphasis, code, links and citations go; underscores inside words stay", (t) => {
  t.is(
    plainText("The deploy fails with E_SYNC_SCOPE and **stops** at `sable rules check`."),
    "The deploy fails with E_SYNC_SCOPE and stops at sable rules check.",
  );
  t.is(plainText("pgvector, PostGIS, pg_trgm, uuid-ossp"), "pgvector, PostGIS, pg_trgm, uuid-ossp");
  t.is(plainText("An _italic_ word and *another* one."), "An italic word and another one.");
  t.is(plainText("See [the notes](https://x.test/a) [1](https://x.test/b)."), "See the notes .");
  t.is(plainText("2 * 3 * 4 is 24"), "2 * 3 * 4 is 24");
});

test("list, quote and heading markers go at the start of a line, not inside one", (t) => {
  t.is(
    plainText("is well established.\n- The cost of Dsup is not characterised.\n1. Next"),
    "is well established. The cost of Dsup is not characterised. Next",
  );
  t.is(plainText("> A quote\n## A heading"), "A quote A heading");
  t.is(plainText("a well-known 3-2 result"), "a well-known 3-2 result");
});

test("a summary is the answer's first paragraph as plain text", (t) => {
  t.is(
    summaryOf("# Title\n\nWrites fail with E_PLAN_LIMIT; reads keep working.\n\nMore."),
    "Writes fail with E_PLAN_LIMIT; reads keep working.",
  );
  t.is(summaryOf(null), null);
});
