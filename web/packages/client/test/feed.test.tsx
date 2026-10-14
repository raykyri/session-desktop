// The Home feed (`10-home-feed-journal.md` §2).

import type { RecentActivityPage } from "@session/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { act, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { queryKeys } from "../src/api/queries.js";
import { estimateRowHeight } from "../src/features/home/ActivityFeed.js";
import { promptPreview, queryTargetExcerpt } from "../src/features/home/ResearchQueryCard.js";
import { countNewAbove, feedScrollBehavior } from "../src/features/home/useActivityFeedState.js";
import { useNavigationStore } from "../src/stores/navigation.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  activityPage,
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
  Object.defineProperty(scroller, "scrollTop", {
    value: top,
    configurable: true,
    writable: true,
  });
  await act(() => {
    scroller.dispatchEvent(new Event("scroll"));
    return Promise.resolve();
  });
}

test("estimated row height grows with the card's content", (t) => {
  const plain = estimateRowHeight(queryItem(researchQuery()));
  const withRecap = estimateRowHeight(queryItem(researchQuery({ recap: "A summary." })));
  t.true(withRecap > plain, "a recap adds a line");
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

const feedResponses = (page: unknown) => ({
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [
    summary({ id: "t1", title: "Collective memory", workspaceId: WORKSPACE_ID }),
  ],
  "folders.get": { folders: [], membership: {}, collapsed: [] },
  "feed.recentActivity": page,
  "highlights.listFeed": [],
});

test.serial("Home switches among global, personal, and workspace feed caches", async (t) => {
  useNavigationStore.setState({ feedMode: "all", feedAnchorByView: {} });
  const page = activityPage([queryItem(researchQuery())]);
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: feedResponses(page),
  });

  await waitUntil(
    t,
    () => screen.queryAllByRole("heading", { name: "All Users" }).length > 0,
    "the global feed is the default",
  );
  const allCall = app.trpc.calls.find((call) => call.path === "feed.recentActivity");
  t.deepEqual(allCall?.input, { scope: "all", before: null });
  t.truthy(app.queryClient.getQueryData(queryKeys.activity({ scope: "all", workspaceId: null })));

  fireEvent.click(screen.getByRole("button", { name: "Feed scope: All Users" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "My Workspaces" }));
  await waitUntil(
    t,
    () => screen.queryAllByRole("heading", { name: "My Workspaces" }).length > 0,
    "the personal cross-workspace feed is selected",
  );
  const mineCall = app.trpc.calls.filter((call) => call.path === "feed.recentActivity").at(-1);
  t.deepEqual(mineCall?.input, { scope: "mine", before: null });
  t.truthy(app.queryClient.getQueryData(queryKeys.activity({ scope: "mine", workspaceId: null })));
  t.is(useNavigationStore.getState().feedMode, "workspaces");

  fireEvent.click(screen.getByRole("button", { name: "Feed scope: My Workspaces" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Collective memory" }));
  await waitUntil(
    t,
    () => screen.queryAllByRole("heading", { name: "Collective memory" }).length > 0,
    "the current workspace feed is selected",
  );
  const workspaceCall = app.trpc.calls.filter((call) => call.path === "feed.recentActivity").at(-1);
  t.deepEqual(workspaceCall?.input, {
    scope: "workspace",
    workspaceId: WORKSPACE_ID,
    before: null,
  });
  t.truthy(
    app.queryClient.getQueryData(
      queryKeys.activity({
        scope: "workspace",
        workspaceId: WORKSPACE_ID,
      }),
    ),
  );
  t.is(useNavigationStore.getState().feedMode, "workspace");
  app.unmount();
});

test.serial("guests see only All Users without a scope switcher", async (t) => {
  useNavigationStore.setState({ feedMode: "workspace", feedAnchorByView: {} });
  const app = await renderApp("/?feed=workspaces", {
    user: null,
    queryClient: testQueryClient(),
    responses: feedResponses(activityPage([])),
  });

  await waitUntil(
    t,
    () => screen.queryAllByRole("heading", { name: "All Users" }).length > 0,
    "guest Home is global",
  );
  t.is(screen.queryByRole("button", { name: /Feed scope:/ }), null);
  const call = app.trpc.calls.find((entry) => entry.path === "feed.recentActivity");
  t.deepEqual(call?.input, { scope: "all", before: null });
  app.unmount();
  useNavigationStore.setState({ feedMode: "all" });
});

test.serial("renders pagination for a cursor and fetches the next page on click", async (t) => {
  const app = await renderApp(`/?feed=${WORKSPACE_ID}`, {
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
  app.unmount();
});

test.serial("feed card menu omits folder actions", async (t) => {
  useNavigationStore.setState({ feedAnchorByView: {} });
  const app = await renderApp(`/?feed=${WORKSPACE_ID}`, {
    queryClient: testQueryClient(),
    responses: feedResponses(activityPage([queryItem(researchQuery())])),
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
  t.truthy(within(menu).queryByText("Rename"));
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
  const modelMark = within(screen.getByRole("feed")).getByRole("button", {
    name: "Gemini 3.8 Flash",
  });
  t.truthy(modelMark, "the model name is the Gemini mark");
  const feedArticle = modelMark.closest("[role='article']");
  t.truthy(feedArticle?.querySelector("time[datetime]"), "the timestamp sits next to the mark");
  t.is(feedArticle?.querySelectorAll("time").length, 1, "the timestamp above the question is gone");
  t.is(within(feedArticle as HTMLElement).queryByText("Gemini 3.8 Flash"), null);
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
  const app = await renderApp(`/?feed=${WORKSPACE_ID}`, {
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
    "the older page loads",
  );
  await scrollFeedTo(900);

  // An arrival above the reader, the way the event bridge patches page 0.
  app.queryClient.setQueryData<InfiniteData<RecentActivityPage>>(
    queryKeys.activity({ scope: "workspace", workspaceId: WORKSPACE_ID }),
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
  useNavigationStore.setState({ feedMode: "all", feedAnchorByView: {} });
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
    useNavigationStore.getState().feedAnchorFor("all-users")?.top,
    900,
    "the click flushes scrollTop so a back navigation can restore it",
  );
  app.unmount();
});

test.serial("returning to the feed restores the scroll offset it was left at", async (t) => {
  useNavigationStore.setState({
    feedMode: "all",
    feedAnchorByView: {
      ["all-users"]: { key: "research:n1", offset: 0, top: 900 },
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

test.serial("unmounting the feed does not replace a saved offset with scrollTop 0", async (t) => {
  useNavigationStore.setState({ feedMode: "all", feedAnchorByView: {} });
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
  t.is(useNavigationStore.getState().feedAnchorFor("all-users")?.top, 900);
  app.unmount();
  t.is(
    useNavigationStore.getState().feedAnchorFor("all-users")?.top,
    900,
    "a detached scroller reading scrollTop 0 must not wipe the flushed position",
  );
});

/** A hydrated post, as `shared/journal/tweets.ts` normalizes one. */
function tweetSnapshot() {
  return {
    id: "20",
    url: "https://x.com/session/status/20",
    author: { name: "Session", handle: "session", verified: true },
    createdAt: "2022-12-04T00:00:00.000Z",
    runs: [{ kind: "text" as const, text: "A post about bloom filters" }],
    partial: false,
    media: [],
    likes: 3,
  };
}

test.serial(
  "a running question says it is generating rather than repeating its status",
  async (t) => {
    useNavigationStore.setState({ feedMode: "all", feedAnchorByView: {} });
    const page = activityPage([queryItem(researchQuery({ status: "running" }))]);
    const app = await renderApp("/", {
      queryClient: testQueryClient(),
      responses: feedResponses(page),
    });

    await waitUntil(
      t,
      () => screen.queryAllByText("Generating answer").length > 0,
      "the card says the answer is being written",
    );
    // The status word beside the model would only restate the line above it;
    // the desktop drops its whole footer while a question runs.
    t.is(screen.queryByText("Running"), null);
    t.is(screen.queryByText("Queued"), null);
    app.unmount();
  },
);

test.serial("an embedded post replaces the permalink that trailed the question", async (t) => {
  useNavigationStore.setState({ feedMode: "all", feedAnchorByView: {} });
  const url = "https://x.com/session/status/20";
  const page = activityPage([
    queryItem(
      researchQuery({
        prompt: `What about this? ${url}`,
        attachments: [
          {
            kind: "tweet",
            schemaVersion: 1,
            sourceUrl: url,
            tweetId: "20",
            placement: "trailing",
            provider: "xSyndication",
            status: "resolved",
            attemptedAt: 1,
            fetchedAt: 2,
            tweet: tweetSnapshot(),
          },
        ],
      }),
    ),
  ]);
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: feedResponses(page),
  });

  const embed = await screen.findByRole("link", { name: "Open post by @session" });
  t.truthy(within(embed).getByText("A post about bloom filters"));
  t.truthy(screen.getByText("What about this?"));
  t.is(screen.queryByText(`What about this? ${url}`), null, "the card stands in for the URL");
  t.truthy(screen.getByRole("list", { name: "Attached posts" }));
  app.unmount();
});
