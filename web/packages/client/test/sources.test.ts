// Phase 2 review round 1, finding 4: the source reader's link to the
// original is the stored url (kept without a scheme) as an https address;
// an uploaded file has none.

import test from "ava";

import { sourceHref } from "../src/spaces/Sources.js";

test("a source's original is its stored url over https", (t) => {
  t.is(sourceHref("x.com/tamsin_rook/status/18580"), "https://x.com/tamsin_rook/status/18580");
  t.is(sourceHref("arxiv.org/abs/2401.00001"), "https://arxiv.org/abs/2401.00001");
  // a url stored with its scheme keeps it
  t.is(sourceHref("http://example.org/a"), "http://example.org/a");
});

test("an uploaded file and an empty url have no original", (t) => {
  t.is(sourceHref("session.app/files/notes%20on%20tables.pdf"), undefined);
  t.is(sourceHref(""), undefined);
  t.is(sourceHref(null), undefined);
  t.is(sourceHref(undefined), undefined);
});
