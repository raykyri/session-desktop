// The Highlights page (`10-home-feed-journal.md` §4), as the desktop's
// `ResearchHighlightsFeed.tsx`.

import { fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import {
  groupHighlightsByThread,
  highlightExcerptContext,
  mayRemoveFeedHighlight,
} from "../src/features/highlights/HighlightsFeed.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  activityPage,
  highlightItem,
  serverSettings,
  workspace,
  WORKSPACE_ID,
} from "./phase6Fixtures.js";

test("highlights group by thread in feed order, each group oldest first", (t) => {
  const groups = groupHighlightsByThread([
    highlightItem({ highlightId: "a", treeId: "t2", treeTitle: "Second", createdAt: 30 }),
    highlightItem({ highlightId: "b", treeId: "t1", treeTitle: "First", createdAt: 20 }),
    highlightItem({ highlightId: "c", treeId: "t2", treeTitle: "Second", createdAt: 10 }),
  ]);
  t.deepEqual(
    groups.map((group) => [group.title, group.items.map((item) => item.highlightId)]),
    [
      ["Second", ["c", "a"]],
      ["First", ["b"]],
    ],
  );
});

test("an excerpt keeps 60 characters of its paragraph, cut at a word and marked", (t) => {
  t.deepEqual(highlightExcerptContext("Memory is ", "prefix"), { text: "Memory is ", cut: false });
  t.deepEqual(highlightExcerptContext("Earlier paragraph.\nThis one", "prefix"), {
    text: "This one",
    cut: false,
  });
  const long = "word ".repeat(30);
  const prefix = highlightExcerptContext(long, "prefix");
  t.true(prefix.cut);
  t.true(prefix.text.length <= 60);
  t.false(prefix.text.startsWith("ord"), "starts at a word");
  const suffix = highlightExcerptContext(` ${long}`, "suffix");
  t.true(suffix.cut);
  t.true(suffix.text.length <= 60);
});

test("only a highlight in a thread the reader owns offers Remove", (t) => {
  const item = highlightItem({ treeId: "t1" });
  t.true(mayRemoveFeedHighlight(item, []), "the feed lists the reader's own threads");
  t.true(mayRemoveFeedHighlight(item, [summary({ id: "t1", role: "owner" })]));
  t.false(mayRemoveFeedHighlight(item, [summary({ id: "t1", role: "commenter" })]));
});

test("with the author and role on the row, its author or the owner may remove it", (t) => {
  const row = (fields: { authorId?: string | null; role?: string }) => ({
    ...highlightItem({ treeId: "t1" }),
    ...fields,
  });
  t.true(mayRemoveFeedHighlight(row({ authorId: "u2", role: "owner" }), [], "u1"));
  t.true(mayRemoveFeedHighlight(row({ authorId: "u1", role: "commenter" }), [], "u1"));
  t.false(mayRemoveFeedHighlight(row({ authorId: "u2", role: "commenter" }), [], "u1"));
  t.false(mayRemoveFeedHighlight(row({ authorId: null, role: "viewer" }), [], "u1"));
  // The row's fields win over a cached list.
  t.false(
    mayRemoveFeedHighlight(
      row({ authorId: "u2", role: "commenter" }),
      [summary({ id: "t1", role: "owner" })],
      "u1",
    ),
  );
});

function responses(
  items = [highlightItem({ nodeLabel: "Roots", treeTitle: "Collective memory" })],
) {
  return {
    "workspaces.list": [workspace()],
    "settings.get": serverSettings(),
    "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
    "folders.get": { folders: [], membership: {}, collapsed: [] },
    "feed.recentActivity": activityPage([]),
    "highlights.listFeed": items,
    "highlights.removeMany": [{ id: "h1" }],
  };
}

test.serial("the page lists each passage under its thread, with its message's label", async (t) => {
  const app = await renderApp("/highlights", { responses: responses() });

  await waitUntil(
    t,
    () => screen.queryAllByText("a shared store of meaning").length > 0,
    "the highlighted passage is rendered",
  );
  const group = screen.getByRole("region", { name: "Collective memory" });
  t.truthy(within(group).getByText("Roots"), "the row names the highlighted message");
  t.truthy(screen.getByRole("button", { name: "Refresh Highlights" }));
  app.unmount();
});

test.serial("Remove highlight removes it, and Refresh reads the list again", async (t) => {
  const app = await renderApp("/highlights", { responses: responses() });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Remove highlight" }) !== null,
    "the row offers Remove",
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove highlight" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "highlights.removeMany"),
    "the removal reaches the server",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "highlights.removeMany")?.input, {
    nodeId: "n1",
    highlightIds: ["h1"],
  });
  await waitUntil(
    t,
    () => screen.queryByText("a shared store of meaning") === null,
    "the row leaves the page",
  );
  t.truthy(screen.getByText("No highlights. Select text in an answer and choose Highlight."));

  const before = app.trpc.calls.filter((call) => call.path === "highlights.listFeed").length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh Highlights" }));
  await waitUntil(
    t,
    () => app.trpc.calls.filter((call) => call.path === "highlights.listFeed").length > before,
    "Refresh refetches",
  );
  app.unmount();
});
