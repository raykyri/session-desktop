// A collapsed note's glyph is the square chevron. Expanded notes, and every
// other kind, keep the shapes in RowGlyph.

import test from "ava";
import { renderToStaticMarkup } from "react-dom/server";

import { RowGlyph } from "../src/ui/RowGlyph.js";

test("a collapsed note draws the square chevron and keeps its state name", (t) => {
  const html = renderToStaticMarkup(<RowGlyph kind="note" state="running" collapsed />);
  t.regex(html, /aria-label="Running"/);
  t.regex(html, /lucide-square-chevron-right/);
  t.regex(html, /session-row-pulse/);
  t.regex(html, /data-research-row-glyph="note"/);
  t.notRegex(html, /M4\.7 5\.6h4\.6/);

  const open = renderToStaticMarkup(<RowGlyph kind="note" state="running" />);
  t.regex(open, /M4\.7 5\.6h4\.6/);
  t.notRegex(open, /lucide-square-chevron-right/);
});
