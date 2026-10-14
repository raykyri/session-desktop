// The sidebar (`10-home-feed-journal.md` §7): the places, ported from the
// desktop's `ResearchSidebarNav.tsx`, the folder dialogs behind them, the
// folder state's writes, and the workspace switcher.

import type { ResearchFolderState } from "@session/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { queryKeys } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { useFolderDialogStore } from "../src/features/home/FolderDialogsHost.js";
import { commitFolderState } from "../src/features/home/useFiling.js";
import { workspaceRemovalRefusal } from "../src/features/sidebar/WorkspaceSwitcher.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import { serverSettings, testQueryClient, workspace, WORKSPACE_ID } from "./phase6Fixtures.js";
import { createTrpcStub } from "./trpcStub.js";

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

const PAPERS = { id: "f1", name: "Papers", workspaceId: WORKSPACE_ID };

function sidebarResponses(folders = folderState({ folders: [PAPERS] })): Record<string, unknown> {
  return {
    "workspaces.list": [workspace()],
    "settings.get": serverSettings(),
    "research.listTrees": [summary({ id: "t1", title: "First", workspaceId: WORKSPACE_ID })],
    "folders.get": folders,
    "folders.set": (input: { state: ResearchFolderState }) => input.state,
    "drafts.list": [],
    "research.listTrash": [],
    "feed.recentQueriesForTrees": [],
    "highlights.listFeed": [],
  };
}

// The folder dialogs' state is a store that outlives one rendered app.
test.beforeEach(() => {
  useFolderDialogStore.setState({ nameRequest: null, pendingDelete: null, returnFocus: null });
});

function rows(name: "Research" | "Folders"): HTMLElement[] {
  return within(screen.getByRole("navigation", { name })).getAllByRole("link");
}

test("workspace removal is blocked while threads are active and permitted when idle", (t) => {
  t.is(workspaceRemovalRefusal(0), null);
  t.regex(String(workspaceRemovalRefusal(1)), /still running/);
  t.regex(String(workspaceRemovalRefusal(3)), /^3 threads/);
});

test.serial("a folder change shows at once and takes the server's copy", async (t) => {
  const client = testQueryClient();
  const stub = createTrpcStub({
    "folders.set": (input: { state: ResearchFolderState }) => ({
      ...input.state,
      collapsed: ["normalized"],
    }),
  });
  setTrpcClient(stub.client);
  client.setQueryData(queryKeys.folders(WORKSPACE_ID), folderState());
  const writing = commitFolderState(client, WORKSPACE_ID, (state) => ({
    ...state,
    membership: { t1: "f1" },
  }));
  t.deepEqual(
    client.getQueryData<ResearchFolderState>(queryKeys.folders(WORKSPACE_ID))?.membership,
    { t1: "f1" },
    "written before the server answers",
  );
  await writing;
  t.deepEqual(
    client.getQueryData<ResearchFolderState>(queryKeys.folders(WORKSPACE_ID))?.collapsed,
    ["normalized"],
  );
  setTrpcClient(null);
});

test.serial("a refused folder change restores the state it replaced and rejects", async (t) => {
  const client = testQueryClient();
  const stub = createTrpcStub({
    "folders.set": () => {
      throw new Error("A folder named “Papers” already exists.");
    },
  });
  setTrpcClient(stub.client);
  const before = folderState({ folders: [PAPERS] });
  client.setQueryData(queryKeys.folders(WORKSPACE_ID), before);
  await t.throwsAsync(
    commitFolderState(client, WORKSPACE_ID, (state) => ({
      ...state,
      folders: [...state.folders, { id: "f2", name: "Papers", workspaceId: WORKSPACE_ID }],
    })),
    { message: "A folder named “Papers” already exists." },
  );
  t.deepEqual(client.getQueryData(queryKeys.folders(WORKSPACE_ID)), before);
  setTrpcClient(null);
});

test.serial(
  "the sidebar lists Home, Highlights, Shared with me, then Drafts, the folders, Archive and Trash",
  async (t) => {
    const app = await renderApp("/", {
      queryClient: testQueryClient(),
      responses: sidebarResponses(),
    });
    await waitUntil(
      t,
      () => screen.queryByRole("navigation", { name: "Folders" }) !== null,
      "places",
    );
    await waitUntil(t, () => rows("Folders").length === 4, "the folder rows");

    t.deepEqual(
      rows("Research").map((row) => row.textContent),
      ["Home", "Highlights", "Shared with me"],
    );
    t.deepEqual(
      rows("Folders").map((row) => row.textContent),
      ["Drafts", "Papers", "Archive", "Trash"],
    );
    // Every place but Highlights and Trash takes card drops; Home is Unfiled.
    const drops = [...rows("Research"), ...rows("Folders")].map(
      (row) => row.parentElement?.dataset["researchDrop"] ?? null,
    );
    t.deepEqual(drops, [
      "system:unfiled",
      null,
      null,
      "system:drafts",
      "f1",
      "system:archive",
      null,
    ]);
    t.is(rows("Research")[0]?.getAttribute("aria-current"), "page");
    app.unmount();
  },
);

test.serial("New folder asks for a name, refuses a taken one, and saves the folder", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: sidebarResponses(),
  });
  await waitUntil(t, () => screen.queryByRole("button", { name: "New folder" }) !== null, "button");

  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  const dialog = await screen.findByRole("dialog", { name: "New folder" });
  const field = within(dialog).getByRole("textbox", { name: "Folder name" });
  t.is((field as HTMLInputElement).value, "", "a new folder has no default name");

  fireEvent.change(field, { target: { value: "papers" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  t.is(
    (await within(dialog).findByRole("alert")).textContent,
    "A folder named “papers” already exists.",
  );

  fireEvent.change(field, { target: { value: "Reading  list " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "the folder is saved",
  );
  const saved = app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.deepEqual(
    saved.state.folders.map((folder) => folder.name),
    ["Papers", "Reading list"],
  );
  await waitUntil(t, () => screen.queryByRole("dialog") === null, "the dialog closes");
  app.unmount();
});

test.serial("the server's refusal shows in the name dialog with the name kept", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...sidebarResponses(),
      "folders.set": () => {
        throw new Error("Use 40 characters or fewer.");
      },
    },
  });
  await waitUntil(t, () => screen.queryByRole("button", { name: "New folder" }) !== null, "button");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  const dialog = await screen.findByRole("dialog", { name: "New folder" });
  const field = within(dialog).getByRole("textbox", { name: "Folder name" });
  fireEvent.change(field, { target: { value: "Reading" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  t.is((await within(dialog).findByRole("alert")).textContent, "Use 40 characters or fewer.");
  t.is((field as HTMLInputElement).value, "Reading");
  app.unmount();
});

test.serial("a folder's Delete… opens its view with the two-step confirmation", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: sidebarResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Actions for Papers" }) !== null,
    "the folder menu",
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions for Papers" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));

  const dialog = await screen.findByRole("dialog", { name: "Delete “Papers”?" });
  t.truthy(await screen.findByRole("heading", { name: "Papers", level: 1 }), "the folder's view");
  t.regex(dialog.textContent ?? "", /The folder is empty\. It moves to the Trash\./);
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "the folder moves to the Trash",
  );
  const saved = app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.is(typeof saved.state.folders[0]?.trashedAt, "number");
  await waitUntil(
    t,
    () => screen.queryByRole("heading", { name: "Home", level: 1 }) !== null,
    "back on Home",
  );
  app.unmount();
});

test.serial("Rename… renames the folder", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: sidebarResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Actions for Papers" }) !== null,
    "the folder menu",
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions for Papers" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
  const field = within(dialog).getByRole("textbox", { name: "Folder name" });
  t.is((field as HTMLInputElement).value, "Papers");
  fireEvent.change(field, { target: { value: "Articles" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "the name is saved",
  );
  const saved = app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.is(saved.state.folders[0]?.name, "Articles");
  app.unmount();
});

test.serial("creating a workspace names it and sends the name", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...sidebarResponses(),
      "workspaces.create": workspace({ id: "w2", name: "Reading" }),
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("Collective memory").length > 0,
    "the switcher shows the scoped workspace",
  );
  fireEvent.click(screen.getAllByText("Collective memory")[0] as HTMLElement);
  fireEvent.click(await screen.findByText("New workspace…"));
  const field = await screen.findByLabelText("Workspace name");
  fireEvent.change(field, { target: { value: "Reading" } });
  const dialog = field.closest<HTMLElement>("[role='dialog']");
  if (!dialog) throw new Error("the name prompt is not a dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

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

test.serial("guests see Home alone", async (t) => {
  const app = await renderApp("/", {
    user: null,
    queryClient: testQueryClient(),
    responses: { "feed.recentActivity": { items: [], nextCursor: null } },
  });
  await waitUntil(
    t,
    () => screen.queryByRole("navigation", { name: "Research" }) !== null,
    "the places",
  );
  t.deepEqual(
    rows("Research").map((row) => row.textContent),
    ["Home"],
  );
  t.is(screen.queryByRole("navigation", { name: "Folders" }), null);
  app.unmount();
});
