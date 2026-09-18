// The Home feed (`10-home-feed-journal-encyclopedia.md` §2, §3).

import { fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { estimateRowHeight } from "../src/features/home/ActivityFeed.js";
import { promptPreview, queryTargetExcerpt } from "../src/features/home/ResearchQueryCard.js";
import { countNewAbove } from "../src/features/home/useActivityFeedState.js";
import { journalEntryMenuItems, journalEntryUrl } from "../src/features/journal/entryMenu.js";
import { useNavigationStore } from "../src/stores/navigation.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  activityPage,
  journalItem,
  linkEntry,
  queryItem,
  researchQuery,
  serverSettings,
  testQueryClient,
  workspace,
  WORKSPACE_ID,
} from "./phase6Fixtures.js";

// jsdom implements no layout, so every element reports `offsetHeight === 0`
// and the virtualizer's range comes out empty. The feed is the one view whose
// rendered rows depend on a viewport height, so this file gives it one.
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

test.before(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset["index"] === undefined ? 800 : 120;
    },
  });
});

test.after.always(() => {
  if (realOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", realOffsetHeight);
  }
});

test("a row's first height guess follows what the row will contain", (t) => {
  const plain = estimateRowHeight(queryItem(researchQuery()));
  const withRecap = estimateRowHeight(queryItem(researchQuery({ recap: "A summary." })));
  t.true(withRecap > plain, "a recap adds a line");
  const link = estimateRowHeight(journalItem(linkEntry()));
  t.true(link < withRecap + 300, "and a link card is the short one");
});

test("only items that arrived above the reader's row are counted as new", (t) => {
  const known = new Set(["b", "c"]);
  t.is(countNewAbove("b", ["a", "b", "c"], known), 1, "one arrival above the previous top");
  t.is(countNewAbove("b", ["b", "c"], known), 0, "nothing above it is nothing new");
  t.is(countNewAbove(null, ["a"], known), 0, "a first load announces nothing");
  t.is(countNewAbove("b", ["c", "b"], known), 0, "a row that moved is not an arrival");
});

test("a card shows the question, not the scaffolding around it", (t) => {
  t.is(
    promptPreview("<session_instruction>\nbe brief\n</session_instruction>\nWhat is [[memory]]?"),
    "What is memory?",
  );
});

test("an anchored follow-up quotes the passage it replies to, cut at a word", (t) => {
  t.is(queryTargetExcerpt("a shared store"), "a shared store");
  t.is(queryTargetExcerpt("one two three four five six seven"), "one two three four five…");
  t.is(queryTargetExcerpt("   "), "");
});

test("the journal menu offers what the entry can actually do", (t) => {
  const link = journalEntryMenuItems(linkEntry());
  t.deepEqual(
    link.map((item) => [item.action, item.label, item.key]),
    [
      ["open", "Open link", "O"],
      ["copy", "Copy link", "C"],
      ["delete", "Delete", "D"],
    ],
  );

  const pending = journalEntryMenuItems({
    id: "j2",
    kind: "tweet",
    url: "https://x.com/a/status/1",
    tweetId: "1",
    hydration: "pending",
    createdAt: new Date().toISOString(),
  });
  t.deepEqual(
    pending.map((item) => item.action),
    ["open", "copy", "delete"],
    "there is nothing to retry while the first attempt is in flight",
  );
  t.is(pending[0]?.label, "Open on X", "and an X permalink says so");

  const failed = journalEntryMenuItems({
    id: "j3",
    kind: "tweet",
    url: "https://x.com/a/status/2",
    tweetId: "2",
    hydration: "failed",
    createdAt: new Date().toISOString(),
  });
  t.deepEqual(
    failed.map((item) => [item.action, item.label, item.key]),
    [
      ["open", "Open on X", "O"],
      ["copy", "Copy link", "C"],
      ["retry", "Retry tweet", "R"],
      ["delete", "Delete", "D"],
    ],
  );
});

test("a hydrated post's canonical permalink is what the menu acts on", (t) => {
  t.is(journalEntryUrl(linkEntry()), "https://example.com/a");
  t.is(
    journalEntryUrl({
      id: "j4",
      kind: "tweet",
      url: "https://twitter.com/a/status/3",
      tweetId: "3",
      hydration: "ok",
      createdAt: new Date().toISOString(),
      tweet: {
        id: "3",
        url: "https://x.com/a/status/3",
        author: { name: "A", handle: "a" },
        runs: [],
        partial: false,
        media: [],
      },
    }),
    "https://x.com/a/status/3",
    "the normalized permalink wins over what was typed",
  );
});

test("an entry whose stored URL is not navigable has nothing to open", (t) => {
  // `journal.add` only stores web URLs, but `journal.restore` takes a whole
  // entry from the client, so the renderer gates the stored URL itself.
  const hostile = { ...linkEntry(), url: "javascript:alert(1)" };
  t.is(journalEntryUrl(hostile), null);
  t.deepEqual(
    journalEntryMenuItems(hostile).map((item) => item.action),
    ["copy", "delete"],
  );
});

const feedResponses = (page: unknown) => ({
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [
    summary({ id: "t1", title: "Collective memory", workspaceId: WORKSPACE_ID }),
  ],
  "folders.get": { folders: [], membership: {}, starred: [], collapsed: [] },
  "feed.recentActivity": page,
  "highlights.listFeed": [],
  "documents.list": [],
});

test.serial("a page with a cursor offers older activity, and fetches it once asked", async (t) => {
  const app = await renderApp("/bookmarks", {
    queryClient: testQueryClient(),
    responses: feedResponses(
      activityPage([queryItem(researchQuery({ recap: "A summary." }))], {
        occurredAt: 1_700_000_000_000,
        sourceRank: 1,
        id: "n1",
      }),
    ),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("Load older activity").length > 0,
    "a next cursor offers the older page",
  );
  const before = app.trpc.calls.filter((call) => call.path === "feed.recentActivity").length;
  fireEvent.click(screen.getByText("Load older activity"));
  await waitUntil(
    t,
    () => app.trpc.calls.filter((call) => call.path === "feed.recentActivity").length > before,
    "and asks for it with the cursor",
  );
  const last = app.trpc.calls.filter((call) => call.path === "feed.recentActivity").at(-1);
  t.deepEqual((last?.input as { before?: unknown }).before, {
    occurredAt: 1_700_000_000_000,
    sourceRank: 1,
    id: "n1",
  });
  t.deepEqual((last?.input as { bookmarkedOnly?: boolean }).bookmarkedOnly, true);
  app.unmount();
});

test.serial("removing a journal entry offers an undo that restores the same row", async (t) => {
  useNavigationStore.setState({ feedAnchorByView: {} });
  const app = await renderApp("/bookmarks", {
    queryClient: testQueryClient(),
    responses: {
      ...feedResponses(activityPage([journalItem(linkEntry())])),
      "journal.remove": true,
      "journal.restore": true,
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByLabelText("Entry actions").length > 0,
    "the journal card is on the feed",
  );
  fireEvent.click(screen.getAllByLabelText("Entry actions")[0] as HTMLElement);
  await waitUntil(t, () => screen.queryAllByRole("menu").length > 0, "its menu opens");
  const menu = screen.getAllByRole("menu").at(-1) as HTMLElement;
  fireEvent.click(within(menu).getByText("Delete"));

  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "journal.remove"),
    "the entry is removed",
  );
  await waitUntil(
    t,
    () => screen.queryAllByText("Entry removed").length > 0,
    "and an undo appears",
  );

  fireEvent.click(screen.getByText("Undo"));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "journal.restore"),
    "which hands the whole entry back",
  );
  t.deepEqual(
    (
      app.trpc.calls.find((call) => call.path === "journal.restore")?.input as {
        entry: { id: string };
      }
    ).entry.id,
    "j1",
  );
  app.unmount();
});

test.serial("a card's menu writes the star it offers, and offers no folder row", async (t) => {
  useNavigationStore.setState({ feedAnchorByView: {} });
  const app = await renderApp("/bookmarks", {
    queryClient: testQueryClient(),
    responses: {
      ...feedResponses(activityPage([queryItem(researchQuery())])),
      "folders.set": { folders: [], membership: {}, starred: ["t1"], collapsed: [] },
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("What is collective memory?").length > 0,
    "the research card is on the feed",
  );
  fireEvent.contextMenu(screen.getByText("What is collective memory?"));
  await waitUntil(t, () => screen.queryAllByRole("menu").length > 0, "its menu opens");
  const menu = screen.getAllByRole("menu").at(-1) as HTMLElement;
  // The feed has no folder dialog, so the two rows that would need one are not
  // offered here rather than offered and inert.
  t.is(within(menu).queryByText("New folder with item"), null);
  t.is(within(menu).queryByText("Remove from folder"), null);

  fireEvent.click(within(menu).getByText("Star"));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "starring from the feed is the same folder write the sidebar makes",
  );
  t.deepEqual(
    (
      app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
        state: { starred: string[] };
      }
    ).state.starred,
    ["t1"],
  );
  app.unmount();
});

test.serial("a query card renders its recap and its follow-up questions", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: feedResponses(
      activityPage([
        queryItem(
          researchQuery({
            recap: "A shared store of meaning, maintained by retelling.",
            children: [
              researchQuery({
                nodeId: "n2",
                parentNodeId: "n1",
                prompt: "How does it differ from collective identity?",
                queryTarget: "a shared store of meaning",
                createdAt: 1_700_000_001_000,
              }),
            ],
          }),
        ),
      ]),
    ),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText(/shared store of meaning, maintained/).length > 0,
    "the recap is the card's body once the run has settled",
  );
  await waitUntil(
    t,
    () => screen.queryAllByLabelText("Follow-up questions").length > 0,
    "and the children hang under it",
  );
  const followUps = screen.getByLabelText("Follow-up questions");
  t.regex(followUps.textContent ?? "", /How does it differ from collective identity\?/);
  // The child quotes the passage it was asked about, which is what tells a
  // reader it is anchored rather than a plain continuation.
  t.regex(followUps.textContent ?? "", /@a shared store of meaning/);
  app.unmount();
});
