// The Home feed (`10-home-feed-journal-encyclopedia.md` §2, §3).

import type { RecentActivityPage } from "@session/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { act, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { queryKeys } from "../src/api/queries.js";
import { estimateRowHeight } from "../src/features/home/ActivityFeed.js";
import { promptPreview, queryTargetExcerpt } from "../src/features/home/ResearchQueryCard.js";
import { countNewAbove, feedScrollBehavior } from "../src/features/home/useActivityFeedState.js";
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

/** jsdom does not implement `Element.scrollTo`, so the feed's two "back to the
 * head" controls are observed through a recorder rather than through a
 * scroll position that never moves. */
const scrolls: ScrollToOptions[] = [];
// eslint-disable-next-line @typescript-eslint/unbound-method -- stashed to be reinstalled, not called.
const realScrollTo = HTMLElement.prototype.scrollTo as unknown;

test.before(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset["index"] === undefined ? 800 : 120;
    },
  });
  HTMLElement.prototype.scrollTo = ((options: ScrollToOptions) => {
    scrolls.push(options);
  }) as typeof HTMLElement.prototype.scrollTo;
});

test.after.always(() => {
  if (realOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", realOffsetHeight);
  }
  HTMLElement.prototype.scrollTo = realScrollTo as typeof HTMLElement.prototype.scrollTo;
});

/** The feed's scroll container, which is also what `scrollRef` points at. */
function feedScroller(): HTMLElement {
  const scroller = screen.getByRole("feed").closest(".research-reading-surface");
  if (!scroller) throw new Error("the feed has no scroll container");
  return scroller as HTMLElement;
}

/** jsdom never gives an element a scroll offset of its own, so the reader's
 * position is stated rather than produced. The event is dispatched on the
 * element rather than through `fireEvent.scroll`, which only reaches React's
 * synthetic handlers; the feed subscribes natively. */
async function scrollFeedTo(top: number): Promise<void> {
  const scroller = feedScroller();
  Object.defineProperty(scroller, "scrollTop", { value: top, configurable: true });
  await act(() => {
    scroller.dispatchEvent(new Event("scroll"));
    return Promise.resolve();
  });
}

test("estimated row height corresponds to the row item type", (t) => {
  const plain = estimateRowHeight(queryItem(researchQuery()));
  const withRecap = estimateRowHeight(queryItem(researchQuery({ recap: "A summary." })));
  t.true(withRecap > plain, "a recap adds a line");
  const link = estimateRowHeight(journalItem(linkEntry()));
  t.true(link < withRecap + 300, "and a link card is the short one");
});

test("only items added above the current scroll position count as unread", (t) => {
  const known = new Set(["b", "c"]);
  t.is(countNewAbove("b", ["a", "b", "c"], known), 1, "one arrival above the previous top");
  t.is(
    countNewAbove("b", ["b", "c"], known),
    0,
    "returns zero when no new items precede the current anchor",
  );
  t.is(
    countNewAbove(null, ["a"], known),
    0,
    "returns zero when the initial feed load has no anchor",
  );
  t.is(countNewAbove("b", ["c", "b"], known), 0, "a row that moved is not an arrival");
});

test("feed cards display prompt text without system instructions or XML tags", (t) => {
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

test("journal entry context menus provide actions appropriate to entry status", (t) => {
  const link = journalEntryMenuItems(linkEntry());
  t.deepEqual(
    link.map((item) => [item.action, item.label]),
    [
      ["open", "Open link"],
      ["copy", "Copy link"],
      ["delete", "Delete"],
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
    "the retry action is omitted while the initial request is pending",
  );
  t.is(pending[0]?.label, "Open on X", "an X permalink uses the X-specific label");

  const failed = journalEntryMenuItems({
    id: "j3",
    kind: "tweet",
    url: "https://x.com/a/status/2",
    tweetId: "2",
    hydration: "failed",
    createdAt: new Date().toISOString(),
  });
  t.deepEqual(
    failed.map((item) => [item.action, item.label]),
    [
      ["open", "Open on X"],
      ["copy", "Copy link"],
      ["retry", "Retry tweet"],
      ["delete", "Delete"],
    ],
  );
});

test("journal menu actions target the canonical permalink of hydrated social posts", (t) => {
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
    "the canonical URL takes precedence over the entered URL",
  );
});

test("entries with non-navigable URLs disable link-opening actions", (t) => {
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

test.serial("renders pagination for a cursor and fetches the next page on click", async (t) => {
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
  // No single-letter keycaps: a Base UI menu binds no letter but typeahead,
  // so "D" would move the highlight rather than delete.
  t.is(
    menu.querySelectorAll("kbd").length,
    0,
    "menu items omit keyboard shortcuts without handlers",
  );
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

test.serial("feed card menu includes Star and omits folder actions", async (t) => {
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
  t.is(within(menu).queryByText("New folder with selection"), null);
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
  t.truthy(
    screen.getByRole("button", { name: /Summary: A shared store of meaning/ }),
    "the recap opens the thread the same way the question does",
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

/* -------------------------------------------------------------------------
 * Returning to the head of the feed
 * ---------------------------------------------------------------------- */

test("an animated jump stands down when the platform asks for less motion", (t) => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- stashed to be reinstalled, not called.
  const real = window.matchMedia;
  const stub = (matches: boolean) =>
    ((query: string) =>
      ({
        matches: matches && query.includes("prefers-reduced-motion"),
      }) as MediaQueryList) as typeof window.matchMedia;
  try {
    window.matchMedia = stub(true);
    t.is(feedScrollBehavior(), "auto");
    window.matchMedia = stub(false);
    t.is(feedScrollBehavior(), "smooth");
  } finally {
    window.matchMedia = real;
  }
});

const HEAD_CURSOR = { occurredAt: 1_700_000_000_000, sourceRank: 1, id: "n1" };

/** A head page that offers an older one, and an older page behind it. */
function pagedFeedResponses() {
  const head = activityPage([queryItem(researchQuery())], HEAD_CURSOR);
  const older = activityPage([
    queryItem(
      researchQuery({
        nodeId: "n0",
        prompt: "An older question?",
        createdAt: 1_600_000_000_000,
      }),
    ),
  ]);
  return {
    ...feedResponses(head),
    "feed.recentActivity": (input: unknown) =>
      (input as { before?: unknown }).before ? older : head,
  };
}

test.serial("the new-activity counter offers the way back to the head", async (t) => {
  useNavigationStore.setState({ feedAnchorByView: {} });
  const app = await renderApp("/bookmarks", {
    queryClient: testQueryClient(),
    responses: pagedFeedResponses(),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("Load older activity").length > 0,
    "the head page offers an older one",
  );
  fireEvent.click(screen.getByText("Load older activity"));
  await waitUntil(
    t,
    () => screen.queryAllByText("An older question?").length > 0,
    "the older page lands",
  );
  await scrollFeedTo(900);

  // An arrival above the reader, the way the event bridge patches page 0.
  app.queryClient.setQueryData<InfiniteData<RecentActivityPage>>(
    queryKeys.activity({ workspaceId: WORKSPACE_ID, bookmarkedOnly: true }),
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page, index) =>
              index === 0
                ? {
                    ...page,
                    items: [
                      queryItem(
                        researchQuery({
                          nodeId: "n2",
                          prompt: "A brand-new question?",
                          createdAt: 1_700_000_100_000,
                        }),
                      ),
                      ...page.items,
                    ],
                  }
                : page,
            ),
          }
        : data,
  );

  await waitUntil(
    t,
    () => screen.queryAllByText("1 new update").length > 0,
    "the counter announces what arrived above the reader",
  );
  app.unmount();
});

test.serial("opening a thread writes the feed's current scroll offset immediately", async (t) => {
  useNavigationStore.setState({ feedAnchorByView: {} });
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: feedResponses(activityPage([queryItem(researchQuery())])),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("What is collective memory?").length > 0,
    "the home feed lists a thread",
  );
  await scrollFeedTo(900);
  fireEvent.click(screen.getByText("What is collective memory?"));

  t.is(
    useNavigationStore.getState().feedAnchorFor(`home:${WORKSPACE_ID}`)?.top,
    900,
    "the click flushes scrollTop so a back navigation can restore it",
  );
  app.unmount();
});

test.serial("returning to the feed restores the scroll offset it was left at", async (t) => {
  useNavigationStore.setState({
    feedAnchorByView: {
      [`home:${WORKSPACE_ID}`]: { key: "research:n1", offset: 0, top: 900 },
    },
  });
  scrolls.length = 0;
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: feedResponses(activityPage([queryItem(researchQuery())])),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("What is collective memory?").length > 0,
    "the home feed lists a thread",
  );
  t.true(
    scrolls.some((options) => options.top === 900) || feedScroller().scrollTop === 900,
    "the scroller is returned to the saved offset instead of 0",
  );
  app.unmount();
});
