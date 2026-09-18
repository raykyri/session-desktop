import type { EncyclopediaPageRequest } from "@session/shared";
import test from "ava";

import { encyclopedia } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function request(
  workspaceId: string,
  term: string,
  source: Partial<EncyclopediaPageRequest["source"]> = {},
): EncyclopediaPageRequest {
  return {
    workspaceId,
    term,
    source: {
      nodeId: null,
      treeId: null,
      pageSlug: null,
      question: null,
      excerpt: "an excerpt",
      siblingTerms: [],
      ...source,
    },
  };
}

test("requesting an unknown term creates a generating page with one source", (t) => {
  const fixture = createFixture(t);
  const result = encyclopedia.requestPage(
    fixture.db,
    fixture.userId,
    request(fixture.workspaceId, "Dawn chorus", { nodeId: "node-1", question: "Why?" }),
  );
  t.true(result.shouldGenerate);
  t.is(result.page.slug, "dawn-chorus");
  t.is(result.page.term, "Dawn chorus");
  t.is(result.page.title, "Dawn chorus");
  t.is(result.page.status, "generating");
  t.is(result.page.sources.length, 1);
  t.is(result.page.sources[0]?.nodeId, "node-1");
  t.deepEqual(result.page.links, []);
});

test("a term with no letters or digits has no page", (t) => {
  const fixture = createFixture(t);
  t.throws(
    () => encyclopedia.requestPage(fixture.db, fixture.userId, request(fixture.workspaceId, "!!!")),
    {
      message: /has no letters or digits/,
    },
  );
  t.throws(
    () =>
      encyclopedia.requestPage(
        fixture.db,
        fixture.userId,
        request(fixture.workspaceId, "x".repeat(200)),
      ),
    { message: /at most 160 characters/ },
  );
});

test("sources dedupe by node, then by page, then by excerpt", (t) => {
  const fixture = createFixture(t);
  const make = (source: Partial<EncyclopediaPageRequest["source"]>) =>
    encyclopedia.requestPage(
      fixture.db,
      fixture.userId,
      request(fixture.workspaceId, "Term", source),
    ).page;

  make({ nodeId: "node-1", excerpt: "first" });
  t.is(make({ nodeId: "node-1", excerpt: "different text" }).sources.length, 1);
  t.is(make({ nodeId: "node-2", excerpt: "first" }).sources.length, 2);
  t.is(make({ pageSlug: "other-page", excerpt: "a" }).sources.length, 3);
  t.is(make({ pageSlug: "other-page", excerpt: "b" }).sources.length, 3);
  t.is(make({ excerpt: "loose excerpt" }).sources.length, 4);
  t.is(make({ excerpt: "loose excerpt" }).sources.length, 4);
});

test("the oldest sources are evicted past fifty", (t) => {
  const fixture = createFixture(t);
  for (let index = 0; index < 55; index += 1) {
    encyclopedia.requestPage(
      fixture.db,
      fixture.userId,
      request(fixture.workspaceId, "Term", { nodeId: `node-${index}` }),
    );
  }
  const page = encyclopedia.getPage(fixture.db, fixture.userId, fixture.workspaceId, "term");
  t.is(page?.sources.length, encyclopedia.MAX_STORED_SOURCES);
  t.is(page?.sources[0]?.nodeId, "node-5", "the first five were evicted");
});

test("a failed page is retried, a ready page is left alone", (t) => {
  const fixture = createFixture(t);
  encyclopedia.requestPage(fixture.db, fixture.userId, request(fixture.workspaceId, "Term"));
  encyclopedia.savePage(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    slug: "term",
    title: "Term",
    body: "A body.",
    generatedBy: "gemini-flash",
  });
  const ready = encyclopedia.requestPage(
    fixture.db,
    fixture.userId,
    request(fixture.workspaceId, "Term", { nodeId: "n1" }),
  );
  t.false(ready.shouldGenerate);
  t.is(ready.page.status, "ready");

  encyclopedia.failPage(fixture.db, fixture.userId, fixture.workspaceId, "term", "provider error");
  const retried = encyclopedia.requestPage(
    fixture.db,
    fixture.userId,
    request(fixture.workspaceId, "Term", { nodeId: "n2" }),
  );
  t.true(retried.shouldGenerate);
  t.is(retried.page.status, "generating");
  t.is(retried.page.error, null);
});

test("saving a body recomputes the links from its wikilinks, minus itself", (t) => {
  const fixture = createFixture(t);
  encyclopedia.requestPage(fixture.db, fixture.userId, request(fixture.workspaceId, "Birdsong"));
  const page = encyclopedia.savePage(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    slug: "birdsong",
    title: "Birdsong",
    body: "See [[Dawn chorus]], [[Sound propagation]] and [[Birdsong]] again, plus [[Dawn chorus]].",
    generatedBy: "gemini-flash",
  });
  t.deepEqual(page.links, ["dawn-chorus", "sound-propagation"]);
  t.deepEqual(
    encyclopedia
      .backlinks(fixture.db, fixture.userId, fixture.workspaceId, "dawn-chorus")
      .map((summary) => summary.slug),
    ["birdsong"],
  );
});

test("the listing is ordered by lower(title) then slug", (t) => {
  const fixture = createFixture(t);
  for (const term of ["zebra finch", "Albatross", "albatross colony", "Bittern"]) {
    encyclopedia.requestPage(fixture.db, fixture.userId, request(fixture.workspaceId, term));
  }
  t.deepEqual(
    encyclopedia
      .listPages(fixture.db, fixture.userId, fixture.workspaceId)
      .map((summary) => summary.slug),
    ["albatross", "albatross-colony", "bittern", "zebra-finch"],
  );
  t.is(
    encyclopedia
      .listPages(fixture.db, fixture.userId, fixture.workspaceId)
      .find((summary) => summary.slug === "bittern")?.sourceCount,
    1,
  );
});

test("regenerate and delete move a page through its states", (t) => {
  const fixture = createFixture(t);
  encyclopedia.requestPage(fixture.db, fixture.userId, request(fixture.workspaceId, "Term"));
  encyclopedia.savePage(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    slug: "term",
    title: "Term",
    body: "A body.",
    generatedBy: "gemini-flash",
  });
  t.is(
    encyclopedia.regeneratePage(fixture.db, fixture.userId, fixture.workspaceId, "term").status,
    "generating",
  );
  t.true(encyclopedia.deletePage(fixture.db, fixture.userId, fixture.workspaceId, "term"));
  t.false(encyclopedia.deletePage(fixture.db, fixture.userId, fixture.workspaceId, "term"));
  t.is(encyclopedia.getPage(fixture.db, fixture.userId, fixture.workspaceId, "term"), null);
});

test("source fields are capped and deduped on the way in", (t) => {
  const fixture = createFixture(t);
  const page = encyclopedia.requestPage(
    fixture.db,
    fixture.userId,
    request(fixture.workspaceId, "Term", {
      excerpt: "e".repeat(5000),
      question: "q".repeat(1000),
      siblingTerms: ["Alpha", "alpha", "Beta", ...Array.from({ length: 40 }, (_, i) => `T${i}`)],
    }),
  ).page;
  const source = page.sources[0];
  // The shared truncation marks the cut with an ellipsis, so the stored value
  // is the cap plus that one character.
  t.is([...(source?.excerpt ?? "")].length, 4001);
  t.true(source?.excerpt.endsWith("…"));
  t.is([...(source?.question ?? "")].length, 601);
  t.is(source?.siblingTerms?.length, 24);
  t.deepEqual(source?.siblingTerms?.slice(0, 2), ["Alpha", "Beta"]);
});

test("a page cannot be created in another account's workspace", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "encyclopedia-other");
  t.throws(
    () => encyclopedia.requestPage(fixture.db, fixture.userId, request(other.workspaceId, "Kelp")),
    { message: /workspace .* was not found/ },
  );
  // The slug is still the owner's to take.
  const page = encyclopedia.requestPage(
    fixture.db,
    other.userId,
    request(other.workspaceId, "Kelp"),
  );
  t.is(page.page.slug, "kelp");
});

test("the prompt takes the newest sources; the stored order is the display order", (t) => {
  const fixture = createFixture(t);
  for (let index = 0; index < 7; index += 1) {
    encyclopedia.requestPage(
      fixture.db,
      fixture.userId,
      request(fixture.workspaceId, "Term", {
        nodeId: `node-${index}`,
        excerpt: `excerpt ${index}`,
      }),
    );
  }

  // The five most recent passages, newest first — `encyclopedia.rs:449-453`
  // reverses the stored list before taking five, and taking the front of the
  // ascending list instead would write the page from the oldest excerpts.
  t.deepEqual(
    encyclopedia
      .newestSources(fixture.db, fixture.userId, fixture.workspaceId, "term")
      .map((source) => source.nodeId),
    ["node-6", "node-5", "node-4", "node-3", "node-2"],
  );
  t.is(
    encyclopedia.newestSources(fixture.db, fixture.userId, fixture.workspaceId, "term", 2).length,
    2,
  );

  // What the page carries is untouched: the "Mentioned in" list reads it in
  // the order the links were made.
  t.deepEqual(
    encyclopedia
      .getPage(fixture.db, fixture.userId, fixture.workspaceId, "term")
      ?.sources.map((source) => source.nodeId),
    ["node-0", "node-1", "node-2", "node-3", "node-4", "node-5", "node-6"],
  );

  const other = addUser(fixture.db, "encyclopedia-sources-other");
  t.deepEqual(
    encyclopedia.newestSources(fixture.db, other.userId, fixture.workspaceId, "term"),
    [],
    "another account reads no sources out of a page it does not own",
  );
  t.deepEqual(
    encyclopedia.newestSources(fixture.db, fixture.userId, fixture.workspaceId, "missing"),
    [],
  );
});
