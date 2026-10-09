import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchHighlightsFeed, {
  groupHighlightsByThread,
  highlightExcerptContext,
  type ResearchHighlightsFeedProps,
} from "../src/components/research/ResearchHighlightsFeed";

const noop = () => {};
function render(overrides: Partial<ResearchHighlightsFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchHighlightsFeed, {
    items: [], loading: false, error: null, onOpen: noop, onRefresh: noop, ...overrides,
  }));
}

test("Highlights groups passages by thread, each in context under its question", () => {
  const now = Date.now();
  const html = render({
    onRemove: noop,
    items: [
      {
        highlightId: "h-2", nodeId: "node-2", treeId: "tree", treeTitle: "Collective memory",
        nodeLabel: "Why do rituals persist?", exact: "Rituals encode shared expectations.",
        prefix: "The persistence of a ritual has less to do with belief than with cost. ",
        suffix: " Once that evidence thins, defection becomes cheap.",
        createdAt: now - 2 * 60 * 60 * 1000,
      },
      {
        highlightId: "h-1", nodeId: "node-1", treeId: "doc", treeTitle: "Original title",
        nodeLabel: "Original title", exact: "Body", prefix: "", suffix: "",
        createdAt: now - 3 * 24 * 60 * 60 * 1000,
      },
    ],
  });
  assert.match(html, /research-feed-header-title[^>]*>Highlights</);
  assert.match(html, /aria-label="Refresh Highlights"/);
  assert.match(html, /role="feed" aria-label="Highlights"/);
  // The prefix is cut to 60 characters at a word, so it starts with "…"; the
  // whole suffix fits, and its sentence ends without one.
  assert.match(html, /research-highlight-context">…of a ritual has less to do with belief than with cost\. <\/span><mark class="research-highlight-mark">Rituals encode shared expectations\.<\/mark><span class="research-highlight-context"> Once that evidence thins, defection becomes cheap\.<\/span>/);
  // No context: the mark stands alone.
  assert.match(html, /research-highlight-excerpt"><mark class="research-highlight-mark">Body<\/mark><\/span>/);
  // One group per thread; the question line shows only when it differs from the title.
  assert.match(html, /research-highlight-source">Collective memory<\/div>/);
  assert.match(html, /research-highlight-turn">Why do rituals persist\?<\/span>/);
  assert.equal((html.match(/research-highlight-turn"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="Remove highlight"/g) ?? []).length, 2);
  assert.ok(html.indexOf("Rituals encode") < html.indexOf(">Body<"));
});

test("highlights group by thread in the order threads first appear", () => {
  const item = (id: string, treeId: string) => ({
    highlightId: id, nodeId: id, treeId, treeTitle: treeId, nodeLabel: id,
    exact: id, prefix: "", suffix: "", createdAt: 1,
  });
  const groups = groupHighlightsByThread([item("a", "t1"), item("b", "t2"), item("c", "t1")]);
  assert.deepEqual(
    groups.map((group) => [group.treeId, group.items.map((entry) => entry.highlightId)]),
    [["t1", ["a", "c"]], ["t2", ["b"]]],
  );
});

test("excerpt context stays within its paragraph and reports truncation", () => {
  // Context from an earlier paragraph is dropped, and the paragraph start needs no "…".
  assert.deepEqual(highlightExcerptContext("Earlier paragraph.\nStart of this one ", "prefix"), {
    text: "Start of this one ",
    cut: false,
  });
  assert.deepEqual(highlightExcerptContext(" ends here.\nNext paragraph", "suffix"), {
    text: " ends here.",
    cut: false,
  });
  // At the 128-character context limit, remove the partial word at the
  // boundary and set cut to indicate truncation.
  const stored = "x".repeat(10) + " " + "word ".repeat(30);
  const prefix = highlightExcerptContext(stored.slice(-128), "prefix");
  assert.equal(prefix.cut, true);
  assert.match(prefix.text, /^word /);
  assert.ok(prefix.text.length <= 60);
  assert.deepEqual(highlightExcerptContext("", "suffix"), { text: "", cut: false });
});

test("highlights in one thread list in the order they were made", () => {
  const item = (id: string, createdAt: number) => ({
    highlightId: id, nodeId: id, treeId: "t", treeTitle: "t", nodeLabel: id,
    exact: id, prefix: "", suffix: "", createdAt,
  });
  const [group] = groupHighlightsByThread([item("newer", 2), item("older", 1)]);
  assert.deepEqual(group.items.map((entry) => entry.highlightId), ["older", "newer"]);
});

test("long context trims to the nearest word on the side facing the passage", () => {
  const html = render({
    items: [{
      highlightId: "h", nodeId: "n", treeId: "t", treeTitle: "T", nodeLabel: "T", exact: "X",
      prefix: Array.from({ length: 60 }, (_, index) => `before${index}`).join(" ") + " ",
      suffix: " " + Array.from({ length: 60 }, (_, index) => `after${index}`).join(" "),
      createdAt: Date.now(),
    }],
  });
  const prefix = html.match(/research-highlight-context">…([^<]*)<\/span><mark/);
  const suffix = html.match(/<\/mark><span class="research-highlight-context">([^<]*)…<\/span>/);
  assert.ok(prefix && prefix[1].length <= 140 && prefix[1].endsWith("before59 "));
  assert.ok(prefix && !prefix[1].startsWith("efore"), prefix?.[1].slice(0, 12));
  assert.ok(suffix && suffix[1].length <= 140 && suffix[1].startsWith(" after0"));
  assert.ok(suffix && !/after\d*[a-z]?$/.test(suffix[1].replace(/after\d+$/, "")), suffix?.[1].slice(-12));
});

test("Highlights shows loading, empty, and error states", () => {
  assert.match(render({ loading: true }), /Loading highlights…/);
  assert.match(render(), /No highlights\. Select text in an answer and choose Highlight\./);
  const failed = render({ error: "Backend unavailable" });
  assert.match(failed, /role="alert">Backend unavailable/);
  assert.match(failed, />Retry<\/button>/);
});
