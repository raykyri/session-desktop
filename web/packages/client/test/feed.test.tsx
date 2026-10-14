// Home and the place views (`10-home-feed-journal.md` §1, §2), ported from
// the desktop's `ResearchActivityFeed.tsx`: Unfiled, the trays, nesting, card
// previews, the card menu and the keyboard, Refresh Home and the new
// activities status; and the web's All Users feed.

import type {
  RecentResearchQuery,
  ResearchFolderState,
  ResearchTreeSummary,
} from "@session/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { estimateRowHeight } from "../src/features/home/ActivityFeed.js";
import { archivedFeedTrees, feedRowOpenKey } from "../src/features/home/FeedView.js";
import { countNewAbove, feedScrollBehavior } from "../src/features/home/useActivityFeedState.js";
import { REORDER_FAILED_MESSAGE } from "../src/features/home/useFiling.js";
import { useNotificationsStore } from "../src/stores/notifications.js";

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
// and the virtualizer's range comes out empty. Home's list is the one view
// whose rendered rows depend on a viewport height, so this file gives it one.
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

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

function folderState(overrides: Partial<ResearchFolderState> = {}): ResearchFolderState {
  return {
    folders: [],
    membership: {},
    collapsed: [],
    parents: {},
    collapsedGroups: [],
    ...overrides,
  };
}

function tree(id: string, overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return summary({
    id,
    rootNodeId: `${id}-root`,
    workspaceId: WORKSPACE_ID,
    runningCount: 0,
    completedCount: 1,
    ...overrides,
  });
}

function root(treeId: string, overrides: Partial<RecentResearchQuery> = {}): RecentResearchQuery {
  return researchQuery({ treeId, nodeId: `${treeId}-root`, ...overrides });
}

function homeResponses({
  trees,
  roots,
  folders = folderState(),
}: {
  trees: ResearchTreeSummary[];
  roots: RecentResearchQuery[];
  folders?: ResearchFolderState;
}): Record<string, unknown> {
  return {
    "workspaces.list": [workspace()],
    "settings.get": serverSettings(),
    "research.listTrees": trees,
    "folders.get": folders,
    "folders.set": (input: { state: ResearchFolderState }) => input.state,
    "drafts.list": [],
    "research.listTrash": [],
    "research.reorderTrees": { ok: true },
    "feed.recentQueriesForTrees": (input: { treeIds: string[] }) =>
      roots.filter((entry) => input.treeIds.includes(entry.treeId)),
  };
}

function unfiled(): HTMLElement {
  return screen.getByRole("feed", { name: "Recent activity" });
}

/** A card's open button, by text in its accessible name. */
function card(scope: HTMLElement, name: string): HTMLElement {
  return within(scope).getByRole("button", { name: new RegExp(name) });
}

/* -------------------------------------------------------------------------
 * Pure rules
 * ---------------------------------------------------------------------- */

test("Enter selects a card and → enters it; modified keys do neither", (t) => {
  const key = (name: string, modifiers: Partial<Record<string, boolean>> = {}) => ({
    key: name,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });
  t.is(feedRowOpenKey(key("Enter")), "select");
  t.is(feedRowOpenKey(key("ArrowRight")), "enter-thread");
  t.is(feedRowOpenKey(key("Enter", { altKey: true })), null);
  t.is(feedRowOpenKey(key("ArrowDown")), null);
});

test("the Archive lists its threads newest-archived first", (t) => {
  const trees = [
    tree("a", { archivedAt: 10 }),
    tree("b", { archivedAt: null }),
    tree("c", { archivedAt: 30 }),
  ];
  t.deepEqual(
    archivedFeedTrees(trees).map((entry) => entry.id),
    ["c", "a"],
  );
});

test("only items added above the current scroll position count as new", (t) => {
  const known = new Set(["b", "c"]);
  t.is(countNewAbove("b", ["a", "b", "c"], known), 1);
  t.is(countNewAbove("b", ["b", "c"], known), 0);
  t.is(countNewAbove(null, ["a"], known), 0);
  t.is(countNewAbove("b", ["c", "b"], known), 0, "a row that moved is not an arrival");
});

test("an animated jump stands down when the platform asks for less motion", (t) => {
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: query.includes("reduce"), media: query }),
  });
  t.is(feedScrollBehavior(), "auto");
  if (original) Object.defineProperty(window, "matchMedia", original);
  else Reflect.deleteProperty(window, "matchMedia");
  t.is(feedScrollBehavior(), "smooth");
});

test("a public feed row is taller when its card has a title", (t) => {
  t.true(
    estimateRowHeight(queryItem(researchQuery({ title: "A title" }))) >
      estimateRowHeight(queryItem(researchQuery())),
  );
});

/* -------------------------------------------------------------------------
 * Home
 * ---------------------------------------------------------------------- */

test.serial("Home lists Unfiled, then Drafts, each folder, Archive and Trash", async (t) => {
  const trees = [
    tree("t1", { title: "Collective memory" }),
    tree("t2", { title: "Filed question" }),
    tree("t3", { title: "Old question", archivedAt: 1_700_000_000_000 }),
  ];
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({
      trees,
      roots: [root("t1", { title: "Collective memory" }), root("t2", { prompt: "Filed" })],
      folders: folderState({
        folders: [{ id: "f1", name: "Papers", workspaceId: WORKSPACE_ID }],
        membership: { t2: "f1" },
      }),
    }),
  });

  await waitUntil(t, () => screen.queryByRole("region", { name: "Papers" }) !== null, "trays");
  const regions = screen
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"))
    .filter((name) => name !== "Notifications");
  t.deepEqual(regions, ["Unfiled", "Drafts", "Papers", "Archive", "Trash"]);

  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length > 0, "a card");
  t.truthy(card(unfiled(), "What is collective memory"));
  t.truthy(card(screen.getByRole("region", { name: "Papers" }), "Filed question"));
  t.truthy(card(screen.getByRole("region", { name: "Archive" }), "Old question"));
  // The Trash ends Home collapsed; "+ New folder" follows it.
  t.truthy(screen.getByRole("button", { name: "Expand Trash" }));
  t.truthy(screen.getByRole("button", { name: "+ New folder" }));
  // The Trash takes no drops; the other places do.
  t.is(screen.getByRole("region", { name: "Trash" }).dataset["researchDrop"], undefined);
  t.is(screen.getByRole("region", { name: "Papers" }).dataset["researchDrop"], "f1");
  app.unmount();
});

test.serial("cards show a note's heading, a muted preview and an X post's label", async (t) => {
  const tweet = {
    kind: "tweet" as const,
    sourceUrl: "https://x.com/session/status/1",
    tweetId: "1",
    placement: "trailing" as const,
    status: "resolved" as const,
    provider: "xSyndication" as const,
    fetchedAt: 1,
    tweet: {
      id: "1",
      url: "https://x.com/session/status/1",
      text: "A post",
      author: { name: "Session", handle: "session" },
    },
  };
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({
      trees: [
        tree("note", { type: "post", title: "Reading list" }),
        tree("link", { type: "post", title: "x.com" }),
      ],
      roots: [
        root("note", { type: "post", format: "text", prompt: "# Reading list\n\nOne\n\n\nTwo" }),
        root("link", {
          type: "post",
          format: "link",
          prompt: "https://x.com/session/status/1",
          attachments: [tweet] as unknown as RecentResearchQuery["attachments"],
        }),
      ],
    }),
  });

  await waitUntil(
    t,
    () => document.querySelector("[data-research-feed-preview]") !== null,
    "the note's preview",
  );
  const preview = document.querySelector<HTMLElement>("[data-research-feed-preview]");
  t.is(preview?.textContent, "One\nTwo", "blank lines are removed");
  t.true(preview?.className.includes("line-clamp-3"), "three lines after a heading");
  t.true(preview?.className.includes("text-fg-muted"));
  t.truthy(within(unfiled()).getByText("Reading list"));
  await waitUntil(
    t,
    () => document.querySelector("[data-research-card-labels]") !== null,
    "the link's label",
  );
  t.is(document.querySelector("[data-research-card-labels]")?.textContent, "[Tweet: @session]");
  t.is(document.querySelector(".journal-tweet"), null, "no embed on a card");
  app.unmount();
});

test.serial("a child is listed under its parent, and its toggle collapses the group", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({
      trees: [tree("p", { title: "Parent" }), tree("c", { title: "Child" })],
      roots: [root("p", { prompt: "Parent" }), root("c", { prompt: "Child" })],
      folders: folderState({ parents: { c: "p" } }),
    }),
  });

  await waitUntil(
    t,
    () => within(unfiled()).queryByRole("button", { name: /^Hide 1 item under/ }) !== null,
    "the group toggle",
  );
  t.truthy(card(unfiled(), "Child, in “Parent”"));
  fireEvent.click(within(unfiled()).getByRole("button", { name: /^Hide 1 item under/ }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "the collapsed group is saved",
  );
  const saved = app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.deepEqual(saved.state.collapsedGroups, ["p"]);
  await waitUntil(
    t,
    () => within(unfiled()).queryByRole("button", { name: /Child, in/ }) === null,
    "the child is hidden",
  );
  app.unmount();
});

test.serial("↓ moves between cards, and Enter opens the focused thread", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses({
        trees: [tree("t1", { title: "First" }), tree("t2", { title: "Second" })],
        roots: [root("t1", { prompt: "First" }), root("t2", { prompt: "Second" })],
      }),
      "research.getTree": { tree: { id: "t2" }, nodes: [] },
    },
  });

  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 2, "two cards");
  const first = card(unfiled(), "^First");
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = card(unfiled(), "^Second");
  t.is(document.activeElement, second);
  fireEvent.keyDown(second, { key: "Enter" });
  await waitUntil(
    t,
    () => screen.queryByRole("feed", { name: "Recent activity" }) === null,
    "the thread opened in place of Home",
  );
  app.unmount();
});

test.serial("⌥↓ moves a card down Unfiled and saves the order", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({
      trees: [tree("t1", { title: "First" }), tree("t2", { title: "Second" })],
      roots: [root("t1", { prompt: "First" }), root("t2", { prompt: "Second" })],
    }),
  });

  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 2, "two cards");
  const first = card(unfiled(), "^First");
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.reorderTrees"),
    "the order is saved",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.reorderTrees")?.input, {
    workspaceId: WORKSPACE_ID,
    archived: false,
    treeIds: ["t2", "t1"],
  });
  t.truthy(screen.getByText("Moved to position 2 of 2."));
  app.unmount();
});

test.serial("a refused reorder says the list changed, not which id", async (t) => {
  useNotificationsStore.getState().clear();
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses({
        trees: [tree("t1", { title: "First" }), tree("t2", { title: "Second" })],
        roots: [root("t1", { prompt: "First" }), root("t2", { prompt: "Second" })],
      }),
      "research.reorderTrees": () => {
        throw new Error("research tree t9 is not in the requested sidebar section");
      },
    },
  });
  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 2, "two cards");
  const first = card(unfiled(), "^First");
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  await waitUntil(
    t,
    () =>
      useNotificationsStore.getState().items.some((item) => item.body === REORDER_FAILED_MESSAGE),
    "the readable refusal",
  );
  t.false(
    useNotificationsStore.getState().items.some((item) => item.body.includes("t9")),
    "no id reaches the reader",
  );
  app.unmount();
});

test.serial("Make child of… lists the cards that can hold it and nests under one", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({
      trees: [tree("t1", { title: "First" }), tree("t2", { title: "Second" })],
      roots: [root("t1", { prompt: "First" }), root("t2", { prompt: "Second" })],
    }),
  });

  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 2, "two cards");
  const secondCard = card(unfiled(), "^Second").closest<HTMLElement>("[data-research-card]");
  if (!secondCard) throw new Error("no card");
  fireEvent.click(within(secondCard).getByRole("button", { name: "Thread actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Make child of…" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "First" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "the parent is saved",
  );
  const saved = app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.deepEqual(saved.state.parents, { t2: "t1" });
  app.unmount();
});

test.serial("Move to Archive archives the thread", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses({
        trees: [tree("t1", { title: "First" })],
        roots: [root("t1", { prompt: "First" })],
      }),
      "research.archiveTree": { id: "t1", workspaceId: WORKSPACE_ID, archivedAt: 1 },
    },
  });

  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 1, "a card");
  const firstCard = card(unfiled(), "^First").closest<HTMLElement>("[data-research-card]");
  if (!firstCard) throw new Error("no card");
  fireEvent.click(within(firstCard).getByRole("button", { name: "Thread actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.archiveTree"),
    "archived",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.archiveTree")?.input, {
    treeId: "t1",
  });
  app.unmount();
});

test.serial("Make child of… says why it is disabled", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({
      trees: [tree("t1", { title: "Alone" })],
      roots: [root("t1", { prompt: "Alone" })],
    }),
  });
  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 1, "a card");
  const element = card(unfiled(), "^Alone").closest<HTMLElement>("[data-research-card]");
  if (!element) throw new Error("no card");
  fireEvent.click(within(element).getByRole("button", { name: "Thread actions" }));
  const item = await screen.findByRole("menuitem", { name: /Make child of/ });
  t.is(item.getAttribute("title"), "No question, document or post to nest under");
  app.unmount();
});

test.serial(
  "the card menu takes A for Archive and D for Delete, with the desktop's titles",
  async (t) => {
    const app = await renderApp("/", {
      queryClient: testQueryClient(),
      responses: {
        ...homeResponses({
          trees: [tree("t1", { title: "First" }), tree("t2", { title: "Busy", runningCount: 1 })],
          roots: [root("t1", { prompt: "First" }), root("t2", { prompt: "Busy" })],
        }),
        "research.archiveTree": { id: "t1", workspaceId: WORKSPACE_ID, archivedAt: 1 },
      },
    });
    await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length >= 2, "cards");
    const menuOf = (name: string) => {
      const element = card(unfiled(), name).closest<HTMLElement>("[data-research-card]");
      if (!element) throw new Error("no card");
      fireEvent.click(within(element).getByRole("button", { name: "Thread actions" }));
    };

    menuOf("^Busy");
    const busyDelete = await screen.findByRole("menuitem", { name: /^Delete/ });
    t.is(busyDelete.getAttribute("title"), "Research with active runs cannot be deleted");
    t.is(busyDelete.getAttribute("aria-keyshortcuts"), "D");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitUntil(t, () => screen.queryByRole("menu") === null, "closed");

    menuOf("^First");
    const menu = await screen.findByRole("menu");
    t.is(
      within(menu)
        .getByRole("menuitem", { name: /Archive/ })
        .getAttribute("aria-keyshortcuts"),
      "A",
    );
    // Busy is a question, so First could nest under it; a card alone could not.
    t.is(
      within(menu)
        .getByRole("menuitem", { name: /Make child of/ })
        .getAttribute("title"),
      null,
    );
    fireEvent.keyDown(menu, { key: "a" });
    await waitUntil(
      t,
      () => app.trpc.calls.some((call) => call.path === "research.archiveTree"),
      "A archives",
    );
    app.unmount();
  },
);

/* -------------------------------------------------------------------------
 * The web's other feeds
 * ---------------------------------------------------------------------- */

test.serial("All Users is a sidebar place, and Home has no feed menu", async (t) => {
  const app = await renderApp("/?feed=workspaces", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses({ trees: [], roots: [] }),
      "feed.recentActivity": activityPage([
        queryItem(researchQuery({ prompt: "Shared question" }), WORKSPACE_ID),
      ]),
    },
  });

  // The removed My Workspaces feed's link opens Home.
  t.truthy(await screen.findByRole("heading", { name: "Home", level: 1 }));
  t.is(screen.queryByRole("button", { name: /^Feed/ }), null, "no feed menu");
  t.truthy(screen.getByRole("button", { name: "Refresh Home" }));

  fireEvent.click(screen.getByRole("link", { name: "All Users" }));
  t.truthy(await screen.findByRole("heading", { name: "All Users", level: 1 }));
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: /Shared question/ }) !== null,
    "the card",
  );
  t.is(screen.queryByRole("button", { name: "Thread actions" }), null);
  t.deepEqual(app.trpc.calls.find((call) => call.path === "feed.recentActivity")?.input, {
    scope: "all",
    before: null,
  });
  t.is(screen.getByRole("link", { name: "All Users" }).getAttribute("aria-current"), "page");
  app.unmount();
});

test.serial("Refresh Home reads the workspace's threads again", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: homeResponses({ trees: [tree("t1")], roots: [root("t1")] }),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Refresh Home" }) !== null,
    "header",
  );
  // The desktop's header: Refresh Home, then Import .md report.
  t.truthy(screen.getByRole("button", { name: "Import .md report" }));
  const before = app.trpc.calls.filter((call) => call.path === "research.listTrees").length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh Home" }));
  await waitUntil(
    t,
    () => app.trpc.calls.filter((call) => call.path === "research.listTrees").length > before,
    "the list refetches",
  );
  t.pass();
  app.unmount();
});

test.serial("threads that arrive above the reader count as new activities", async (t) => {
  const queryClient = testQueryClient();
  const app = await renderApp("/", {
    queryClient,
    responses: homeResponses({ trees: [tree("t1")], roots: [root("t1")] }),
  });
  await waitUntil(t, () => within(unfiled()).queryAllByRole("button").length > 0, "a card");
  const scroller = document.querySelector<HTMLElement>("[data-research-scroll]");
  if (!scroller) throw new Error("no scroller");
  Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 400, writable: true });
  scroller.scrollTo = () => {};

  const key = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["trees"] })
    .map((query) => query.queryKey)[0];
  if (!key) throw new Error("no tree list");
  act(() => {
    queryClient.setQueryData(key, [tree("t2"), tree("t1")]);
  });
  const status = await screen.findByRole("button", { name: "1 new activity" });
  fireEvent.click(status);
  t.is(screen.queryByRole("button", { name: "1 new activity" }), null, "cleared on return");
  app.unmount();
});

test.serial("guests see All Users without the feed menu", async (t) => {
  const app = await renderApp("/", {
    user: null,
    queryClient: testQueryClient(),
    responses: { "feed.recentActivity": activityPage([]) },
  });
  t.truthy(await screen.findByRole("heading", { name: "All Users", level: 1 }));
  t.is(screen.queryByRole("button", { name: /^Feed scope/ }), null);
  t.is(screen.queryByRole("textbox", { name: "New question" }), null);
  app.unmount();
});
