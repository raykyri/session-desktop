// A collapsed note group's glyph is the square chevron. Expanded notes, and
// every other kind, keep the shapes in RowGlyph.

import type { RecentResearchQuery } from "@session/shared";
import test from "ava";
import { renderToStaticMarkup } from "react-dom/server";

import { CardBody } from "../src/features/home/CardBody.js";
import { FeedCard } from "../src/features/home/FeedCard.js";
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

test("a collapsed note card uses the square chevron; a link group does not", (t) => {
  const group = {
    count: 1,
    collapsed: true,
    summary: { running: 0, failed: 0, updated: 0 },
    label: "Show 1 item under “Note”",
    onToggle: () => {},
  };
  const note = renderToStaticMarkup(
    <FeedCard
      cardId="n"
      place="system:unfiled"
      body="Body"
      label="Note"
      kind="note"
      onOpen={() => {}}
      group={group}
    />,
  );
  t.regex(note, /data-research-card="n"[^]*?lucide-square-chevron-right/);
  t.notRegex(note, /M4\.7 5\.6h4\.6/);

  const link = renderToStaticMarkup(
    <FeedCard
      cardId="link"
      place="system:unfiled"
      body="https://example.com/a"
      label="Link"
      kind="link"
      onOpen={() => {}}
      group={{ ...group, label: "Show 1 item under “Link”" }}
    />,
  );
  t.regex(link, /M5\.3 8\.7l3\.4-3\.4/);
  t.notRegex(link, /lucide-square-chevron-right/);

  const titled = renderToStaticMarkup(
    <FeedCard
      cardId="q"
      place="system:unfiled"
      title="Title"
      body="Question"
      label="Title"
      onOpen={() => {}}
      group={{ ...group, count: 2, label: "Show 2 items under “Title”" }}
    />,
  );
  t.regex(
    titled,
    /data-research-card-title="">Title<span class="text-fg-muted font-normal"> \(2\)<\/span>/,
  );
});

test("a note group's count follows its heading in the child title color", (t) => {
  const query = {
    nodeId: "n",
    treeId: "n",
    parentNodeId: null,
    inline: false,
    prompt: "# AKA iterations\n\nNotes",
    format: "text",
    status: "complete",
    createdAt: 1,
  } as RecentResearchQuery;
  const html = renderToStaticMarkup(
    <CardBody
      query={query}
      fallback=""
      isPost
      awaitingTitle={false}
      underTitle={false}
      childCount={2}
    />,
  );
  t.regex(html, /AKA iterations<span class="text-fg-muted font-normal"> \(2\)<\/span>/);
});
