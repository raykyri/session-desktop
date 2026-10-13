import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchTileToggle } from "../src/components/research/ResearchTileClamp";
import { ResearchMessageRow } from "../src/components/research/ResearchTurn";
import { researchTileOverflows, toggleResearchTile } from "../src/lib/researchTileClamp";
import type { ResearchMessageAttachment } from "../src/types";
import { researchNode } from "./researchNodeFixture";

const tweet: ResearchMessageAttachment = {
  kind: "tweet",
  schemaVersion: 1,
  sourceUrl: "https://x.com/example/status/1",
  tweetId: "1",
  placement: "trailing",
  provider: "xSyndication",
  status: "resolved",
  attemptedAt: 1,
  tweet: {
    id: "1",
    url: "https://x.com/example/status/1",
    runs: [{ kind: "text", text: "Tweet" }],
    partial: false,
    createdAt: "2025-02-02T23:17:00.000Z",
    author: { name: "Example", handle: "example" },
    media: [],
  },
};

test("clamped text overflows only when its content is taller than its box", () => {
  assert.equal(researchTileOverflows(240, 240), false);
  assert.equal(researchTileOverflows(120, 120), false);
  // Subpixel rounding of the two heights is not overflow.
  assert.equal(researchTileOverflows(241, 240), false);
  assert.equal(researchTileOverflows(242, 240), true);
  assert.equal(researchTileOverflows(600, 240), true);
  // A box with no size (a hidden column) does not overflow.
  assert.equal(researchTileOverflows(0, 0), false);
});

test("toggling a row adds or removes only that row, leaving the input unchanged", () => {
  const none: ReadonlySet<string> = new Set();
  const one = toggleResearchTile(none, "a");
  assert.deepEqual([...one], ["a"]);
  assert.deepEqual([...none], []);
  const two = toggleResearchTile(one, "b");
  assert.deepEqual([...two].sort(), ["a", "b"]);
  const back = toggleResearchTile(two, "a");
  assert.deepEqual([...back], ["b"]);
  assert.deepEqual([...two].sort(), ["a", "b"]);
});

test("the toggle is a button that names its state and controls the clamp box", () => {
  const toggle = (expanded: boolean) =>
    renderToStaticMarkup(
      createElement(ResearchTileToggle, { controls: "clamp-1", expanded, tabIndex: -1, onToggle: () => {} }),
    );
  assert.equal(
    toggle(false),
    '<button type="button" class="research-msg-more" data-research-no-drag="" aria-expanded="false" aria-controls="clamp-1" tabindex="-1">Show more</button>',
  );
  assert.match(toggle(true), /aria-expanded="true"[^>]*>Show less<\/button>$/);
});

const noop = () => {};
const row = (overrides: Partial<Parameters<typeof ResearchMessageRow>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ResearchMessageRow, {
      node: researchNode({
        id: "n1",
        prompt: "A long question\n\nwith a second paragraph",
        status: "complete",
        attachments: [tweet],
      }),
      level: 0,
      label: "A long question",
      showPrompt: true,
      selected: false,
      starrable: false,
      branchCount: 0,
      branchOpen: false,
      branchUnread: false,
      answerMenuOpen: false,
      registerSegmentElement: noop,
      onSelect: noop,
      onToggleBranches: noop,
      onOpenAnswerMenu: noop,
      onOpenContextMenu: noop,
      onToggleExpanded: noop,
      ...overrides,
    }),
  );

test("a row clamps its text, not its tweet card", () => {
  const html = row();
  const clamp = /<div id="[^"]+" class="research-msg-clamp is-clamped"><div class="research-msg-clamp-text">/.exec(html);
  assert.ok(clamp);
  const attachments = html.indexOf('class="research-message-attachments has-prompt"');
  assert.ok(attachments > html.indexOf("</div></div>", clamp.index), "the tweet card follows the clamp box");
  // Unmeasured text (no layout here) shows no toggle.
  assert.doesNotMatch(html, /research-msg-more/);
});

test("an expanded row is unclamped and shows Show less for its clamp box", () => {
  const html = row({ expanded: true, selected: true });
  const clamp = /<div id="([^"]+)" class="research-msg-clamp">/.exec(html);
  assert.ok(clamp);
  assert.ok(
    html.includes(`aria-expanded="true" aria-controls="${clamp[1]}" tabindex="0">Show less</button>`),
    "the toggle controls the clamp box and is in the selected row's tab order",
  );
  // The toggle is below the row's text and tweet card, before the corner pill.
  const toggle = html.indexOf('class="research-msg-more"');
  assert.ok(toggle > html.indexOf("research-message-attachments"));
  assert.ok(toggle < html.indexOf("research-feed-rail"));
  // Without the callback there is no toggle.
  assert.doesNotMatch(row({ expanded: true, onToggleExpanded: undefined }), /research-msg-more/);
});

test("a document's title is clamped as its row's text", () => {
  const html = row({ node: researchNode({ id: "d", type: "document", source: "authored" }), showPrompt: false });
  assert.match(html, /class="research-msg-clamp is-clamped"><span class="research-msg-plain">/);
});
