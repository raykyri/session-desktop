// The sidebar's writes and its two stateful controls
// (`10-home-feed-journal-encyclopedia.md` §7).

import type { ResearchFolderState } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { queryKeys, queryClientDefaults } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { workspaceRemovalRefusal } from "../src/features/sidebar/WorkspaceSwitcher.js";
import { parseVisibilityFilter } from "../src/features/sidebar/filter.js";
import {
  applyFolderState,
  applyOrderToSection,
  applyTreeOrder,
} from "../src/features/sidebar/mutations.js";
import { useNavigationStore } from "../src/stores/navigation.js";
import { useSelectionStore } from "../src/stores/selection.js";

import { summary, tree } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import { activityPage, serverSettings, workspace, WORKSPACE_ID } from "./phase6Fixtures.js";
import { createTrpcStub } from "./trpcStub.js";

function folderState(overrides: Partial<ResearchFolderState> = {}): ResearchFolderState {
  return { folders: [], membership: {}, starred: [], collapsed: [], ...overrides };
}

function testClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

test("a section reorder moves only its own rows", (t) => {
  const trees = [
    summary({ id: "a", workspaceId: "w1" }),
    summary({ id: "x", workspaceId: "w1", archivedAt: 1 }),
    summary({ id: "b", workspaceId: "w1" }),
    summary({ id: "other", workspaceId: "w2" }),
  ];
  const next = applyOrderToSection(trees, "w1", false, ["b", "a"]);
  t.deepEqual(
    next.map((tree) => tree.id),
    ["b", "x", "a", "other"],
  );
});

test("a reorder that does not name the whole section is refused", (t) => {
  const trees = [summary({ id: "a" }), summary({ id: "b" })];
  t.is(applyOrderToSection(trees, "t1-workspace", false, ["a"]), trees);
  t.is(applyOrderToSection(trees, "w1", false, ["a", "a"]), trees);
});

test("a folder write lands optimistically and keeps what the server returned", async (t) => {
  const stored = folderState({ starred: ["t1"] });
  const stub = createTrpcStub({ "folders.set": stored });
  setTrpcClient(stub.client);
  const client = testClient();
  client.setQueryData(queryKeys.folders("w1"), folderState());

  const guess = folderState({ starred: ["t1"], collapsed: ["f1"] });
  const applied = await applyFolderState(client, "w1", guess);

  t.true(applied);
  t.deepEqual(client.getQueryData(queryKeys.folders("w1")), stored);
  t.deepEqual(stub.calls.at(-1), {
    path: "folders.set",
    kind: "mutate",
    input: { workspaceId: "w1", state: guess },
  });
});

test("a refused folder write rolls the cache back to exactly what was there", async (t) => {
  const before = folderState({ starred: ["t1"] });
  const stub = createTrpcStub({
    "folders.set": () => {
      throw new Error("nope");
    },
  });
  setTrpcClient(stub.client);
  const client = testClient();
  client.setQueryData(queryKeys.folders("w1"), before);

  const applied = await applyFolderState(client, "w1", folderState({ starred: ["t1", "t2"] }));

  t.false(applied);
  t.deepEqual(client.getQueryData(queryKeys.folders("w1")), before);
});

test("a tree reorder is applied to every cached list and rolled back on refusal", async (t) => {
  const stub = createTrpcStub({
    "research.reorderTrees": () => {
      throw new Error("nope");
    },
  });
  setTrpcClient(stub.client);
  const client = testClient();
  const trees = [summary({ id: "a", workspaceId: "w1" }), summary({ id: "b", workspaceId: "w1" })];
  const activeKey = queryKeys.trees({ workspaceId: "w1", includeArchived: false });
  const archivedKey = queryKeys.trees({ workspaceId: "w1", includeArchived: true });
  client.setQueryData(activeKey, trees);
  client.setQueryData(archivedKey, trees);

  let seenDuringFlight: string[] = [];
  const pending = applyTreeOrder(client, "w1", false, ["b", "a"]);
  seenDuringFlight = (client.getQueryData<typeof trees>(activeKey) ?? []).map((tree) => tree.id);
  const applied = await pending;

  t.deepEqual(seenDuringFlight, ["b", "a"], "the move lands before the round trip");
  t.false(applied);
  for (const key of [activeKey, archivedKey]) {
    t.deepEqual(
      (client.getQueryData<typeof trees>(key) ?? []).map((tree) => tree.id),
      ["a", "b"],
      "and is undone when the server refuses",
    );
  }
});

test("the visibility filter accepts only the three it knows", (t) => {
  t.is(parseVisibilityFilter("archived"), "archived");
  t.is(parseVisibilityFilter("all"), "all");
  t.is(parseVisibilityFilter("everything"), null);
  t.is(parseVisibilityFilter(undefined), null);
});

test("a workspace with running threads refuses removal, and one without does not", (t) => {
  t.is(workspaceRemovalRefusal(0), null);
  t.regex(String(workspaceRemovalRefusal(1)), /still running/);
  t.regex(String(workspaceRemovalRefusal(3)), /^3 research threads/);
});

/**
 * Records which elements take pointer capture while `run` executes, and puts
 * the prototype back afterwards. `setPointerCapture` is a jsdom stub
 * (`test/setup.ts`), so swapping it is the only way to see the call the row's
 * drag handler would make.
 */
function capturedPointersDuring(run: () => void): Element[] {
  const captured: Element[] = [];
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "setPointerCapture");
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    writable: true,
    value: function record(this: Element) {
      captured.push(this);
    },
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(Element.prototype, "setPointerCapture", original);
  }
  return captured;
}

const sidebarResponses = {
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [
    summary({ id: "t1", title: "First", workspaceId: WORKSPACE_ID }),
    summary({ id: "t2", title: "Second", workspaceId: WORKSPACE_ID }),
    summary({ id: "t3", title: "Retired", workspaceId: WORKSPACE_ID, archivedAt: 1 }),
  ],
  "folders.get": folderState(),
  "feed.recentActivity": activityPage([]),
  "highlights.listFeed": [],
  "documents.list": [],
};

test.serial("`?filter=` chooses which sections the sidebar shows", async (t) => {
  useSelectionStore.getState().clear();
  useNavigationStore.getState().setVisibilityFilter("active");
  const app = await renderApp("/?filter=archived", { responses: sidebarResponses });

  await waitUntil(
    t,
    () => screen.queryAllByTitle("Retired").length > 0,
    "the archived thread is listed under an archived filter",
  );
  t.is(useNavigationStore.getState().visibilityFilter, "archived");
  t.is(screen.queryAllByTitle("First").length, 0, "and the active list is hidden");
  app.unmount();
});

test.serial("Cmd-click builds a selection and its menu acts on the whole of it", async (t) => {
  useSelectionStore.getState().clear();
  useNavigationStore.getState().setVisibilityFilter("active");
  const app = await renderApp("/", { responses: sidebarResponses });

  await waitUntil(t, () => screen.queryAllByTitle("First").length > 0, "the sidebar lists threads");
  const first = screen.getAllByTitle("First")[0] as HTMLElement;
  const second = screen.getAllByTitle("Second")[0] as HTMLElement;
  fireEvent.click(first, { metaKey: true });
  fireEvent.click(second, { metaKey: true });

  await waitUntil(
    t,
    () => useSelectionStore.getState().ids.length === 2,
    "a modified click extends the selection rather than navigating",
  );
  t.truthy(screen.getByText("2 selected"));

  fireEvent.contextMenu(second);
  await waitUntil(
    t,
    () => screen.queryAllByRole("menu").length > 0,
    "right-clicking inside the selection opens a menu",
  );
  const menu = screen.getAllByRole("menu").at(-1) as HTMLElement;
  t.truthy(within(menu).getByText("New folder with 2 items"));
  useSelectionStore.getState().clear();
  app.unmount();
});

test.serial("creating a workspace names it and sends the name", async (t) => {
  useSelectionStore.getState().clear();
  const app = await renderApp("/", {
    responses: {
      ...sidebarResponses,
      "workspaces.create": workspace({ id: "w2", name: "Reading" }),
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("Collective memory").length > 0,
    "the switcher shows the scoped workspace",
  );
  fireEvent.click(screen.getAllByText("Collective memory")[0] as HTMLElement);
  await waitUntil(
    t,
    () => screen.queryAllByText("New workspace…").length > 0,
    "the switcher menu offers a new workspace",
  );
  fireEvent.click(screen.getByText("New workspace…"));

  await waitUntil(
    t,
    () => screen.queryAllByLabelText("Workspace name").length > 0,
    "the name prompt replaces the desktop's native folder picker",
  );
  const field = screen.getByLabelText("Workspace name");
  fireEvent.change(field, { target: { value: "Reading" } });
  fireEvent.click(screen.getByText("Create"));

  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "workspaces.create"),
    "the name reaches the server",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "workspaces.create")?.input, {
    name: "Reading",
  });
  app.unmount();
});

test.serial("a mouse press on a row menu item stays with the menu", async (t) => {
  useSelectionStore.getState().clear();
  useNavigationStore.getState().setVisibilityFilter("active");
  const app = await renderApp("/", {
    responses: {
      ...sidebarResponses,
      "research.listTrees": [
        summary({ id: "t1", title: "First", workspaceId: WORKSPACE_ID, runningCount: 0 }),
      ],
      "research.archiveTree": tree({ id: "t1", workspaceId: WORKSPACE_ID, archivedAt: 2 }),
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByTitle("First").length > 0,
    "the sidebar lists a thread",
  );
  const row = screen.getAllByTitle("First")[0] as HTMLElement;

  fireEvent.click(screen.getByLabelText("Actions for First"));
  await waitUntil(
    t,
    () => screen.queryAllByRole("menuitem", { name: /^Archive/ }).length > 0,
    "the row's ⋯ menu opens",
  );
  const archive = screen.getByRole("menuitem", { name: /^Archive/ });
  // The premise of the guard: Base UI portals the popup, so the item is a React
  // descendant of the row but not a DOM one.
  t.false(row.contains(archive), "the item is outside the row in the DOM");

  // The row's drag handler must ignore the press React replays onto it. Taking
  // pointer capture here is what used to retarget the release to the row and
  // leave the browser dispatching `click` on `<body>` instead of on the item.
  const captured = capturedPointersDuring(() => {
    fireEvent.pointerDown(archive, { button: 0, pointerId: 1 });
  });
  t.deepEqual(captured, [], "no row captures the pointer");

  fireEvent.click(archive);
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.archiveTree"),
    "the item's own action runs",
  );
  t.false(
    document.body.textContent?.includes("could not be loaded") ?? false,
    "and the thread behind the menu is not opened by the same click",
  );
  app.unmount();
});

test.serial("a press on the row itself still arms the drag", async (t) => {
  useSelectionStore.getState().clear();
  useNavigationStore.getState().setVisibilityFilter("active");
  const app = await renderApp("/", { responses: sidebarResponses });

  await waitUntil(t, () => screen.queryAllByTitle("First").length > 0, "the sidebar lists threads");
  const row = screen.getAllByTitle("First")[0] as HTMLElement;

  const captured = capturedPointersDuring(() => {
    fireEvent.pointerDown(row, { button: 0, pointerId: 1 });
  });
  t.deepEqual(captured, [row], "the row takes the pointer for its own press");
  app.unmount();
});

test.serial("a row badges an unseen update, an unseen failure, and a run in flight", async (t) => {
  useSelectionStore.getState().clear();
  useNavigationStore.getState().setVisibilityFilter("active");
  const app = await renderApp("/", {
    responses: {
      ...sidebarResponses,
      "research.listTrees": [
        summary({ id: "t1", title: "Quiet", workspaceId: WORKSPACE_ID, runningCount: 0 }),
        summary({
          id: "t2",
          title: "Updated",
          workspaceId: WORKSPACE_ID,
          runningCount: 0,
          hasUnseenUpdate: true,
        }),
        summary({
          id: "t3",
          title: "Broken",
          workspaceId: WORKSPACE_ID,
          runningCount: 0,
          // A failure outranks an update: the row has one slot and the worse
          // news is what a reader has to act on.
          hasUnseenUpdate: true,
          hasUnseenFailure: true,
        }),
        summary({ id: "t4", title: "Busy", workspaceId: WORKSPACE_ID, runningCount: 2 }),
      ],
    },
  });

  await waitUntil(t, () => screen.queryAllByTitle("Quiet").length > 0, "the sidebar lists threads");
  const badge = (title: string) =>
    (screen.getAllByTitle(title)[0] as HTMLElement).querySelector("span[title]")?.textContent ?? "";

  t.is(badge("Quiet"), "", "a seen, idle thread carries no badge");
  t.is(badge("Updated"), "New");
  t.is(badge("Broken"), "!");
  t.is(badge("Busy"), "2", "a run in flight shows its count instead");
  app.unmount();
});
