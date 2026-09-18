import test from "ava";

import {
  buildWikilinkExcerpt,
  encyclopediaPageStatusBySlug,
  encyclopediaSummaryOfPage,
  parseEncyclopediaEvent,
  removeEncyclopediaSummary,
  upsertEncyclopediaSummary,
} from "../src/encyclopedia/pages.js";
import type { EncyclopediaPage, EncyclopediaPageSummary } from "../src/types/encyclopedia.js";

test("the excerpt keeps the clicked block and splits the rest between neighbors", (t) => {
  t.is(buildWikilinkExcerpt(null, "  the   block ", null), "the block");
  t.is(
    buildWikilinkExcerpt("before text", "block", "after text"),
    "before text\n\nblock\n\nafter text",
  );
  // Neighbors are cut at word boundaries: the tail of the previous block and
  // the head of the next.
  t.is(
    buildWikilinkExcerpt("alpha beta gamma", "block", "one two three", 25),
    "gamma\n\nblock\n\none two",
  );
});

test("prioritizes clicked block content and allocates remaining excerpt budget to adjacent blocks", (t) => {
  const long = "word ".repeat(400).trim();
  const excerpt = buildWikilinkExcerpt("prev prev", long, "next next", 100);
  t.true(excerpt.length <= 100);
  // A leftover too small for a whole word is dropped rather than padded with
  // a fragment.
  t.false(excerpt.includes("prev"));
  t.false(excerpt.includes("v\n"));
  t.false(excerpt.includes("next"));
  // A single word longer than the limit is cut rather than discarded.
  t.is(buildWikilinkExcerpt(null, "x".repeat(50), null, 10), "x".repeat(10));
});

function summary(
  slug: string,
  title: string,
  status: EncyclopediaPageSummary["status"] = "ready",
): EncyclopediaPageSummary {
  return {
    slug,
    term: title,
    title,
    status,
    workspaceId: "ws",
    createdAt: 1,
    updatedAt: 1,
    sourceCount: 1,
  };
}

test("summaries stay sorted by title and replace by slug", (t) => {
  let pages = upsertEncyclopediaSummary([], summary("zed", "Zed"));
  pages = upsertEncyclopediaSummary(pages, summary("alpha", "alpha"));
  pages = upsertEncyclopediaSummary(pages, summary("mid", "Mid"));
  t.deepEqual(
    pages.map((page) => page.slug),
    ["alpha", "mid", "zed"],
  );
  pages = upsertEncyclopediaSummary(pages, summary("mid", "Aardvark"));
  t.deepEqual(
    pages.map((page) => page.slug),
    ["mid", "alpha", "zed"],
  );
  const same = removeEncyclopediaSummary(pages, "missing");
  t.is(same, pages);
  t.deepEqual(
    removeEncyclopediaSummary(pages, "alpha").map((page) => page.slug),
    ["mid", "zed"],
  );
  t.deepEqual(
    [...encyclopediaPageStatusBySlug([summary("a", "A", "generating"), summary("b", "B")])],
    [
      ["a", "generating"],
      ["b", "ready"],
    ],
  );
});

const page: EncyclopediaPage = {
  slug: "daemon",
  term: "Daemon",
  title: "Daemon (novel)",
  body: "A [[Daniel Suarez]] novel.",
  status: "ready",
  model: "gemini-flash",
  generatedBy: "gemini-flash",
  workspaceId: "ws",
  createdAt: 1,
  updatedAt: 2,
  sources: [{ nodeId: "n1", treeId: "t1", excerpt: "…", createdAt: 1 }],
  links: ["daniel-suarez"],
};

test("a page projects to the summary the sidebar lists", (t) => {
  t.deepEqual(encyclopediaSummaryOfPage(page), {
    ...summary("daemon", "Daemon (novel)"),
    term: "Daemon",
    updatedAt: 2,
  });
});

test("page events parse and unrelated or malformed ones are ignored", (t) => {
  t.deepEqual(
    parseEncyclopediaEvent({ type: "encyclopedia.page.updated", payload: { page }, timestamp: 0 }),
    {
      type: "encyclopedia.page.updated",
      page,
    },
  );
  t.deepEqual(
    parseEncyclopediaEvent({
      type: "encyclopedia.page.removed",
      payload: { workspaceId: "ws", slug: "daemon" },
      timestamp: 0,
    }),
    { type: "encyclopedia.page.removed", workspaceId: "ws", slug: "daemon" },
  );
  t.is(
    parseEncyclopediaEvent({
      type: "encyclopedia.page.updated",
      payload: { page: { slug: "x" } },
      timestamp: 0,
    }),
    null,
  );
  t.is(
    parseEncyclopediaEvent({
      type: "encyclopedia.page.removed",
      payload: { workspaceId: "ws" },
      timestamp: 0,
    }),
    null,
  );
  t.is(parseEncyclopediaEvent({ type: "research.node.updated", payload: {}, timestamp: 0 }), null);
});
