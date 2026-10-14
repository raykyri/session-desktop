// The Trash and the two-step delete (`10-home-feed-journal.md` §1), ported
// from the desktop's `ResearchTrashList.tsx`, `ResearchDeleteDialog.tsx` and
// the Trash's view: Move to Trash with a Delete now link, Restore, Delete now
// in the Trash, and Empty Trash.

import type { ResearchFolderState, ResearchTreeSummary } from "@session/shared";
import type { ResearchTrashEntry } from "@session/shared/lib/researchTrash";
import { fireEvent, render, screen, within } from "@testing-library/react";
import test from "ava";

import { TrashList } from "../src/features/home/TrashList.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { DeleteDialog } from "../src/ui/DeleteDialog.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  researchQuery,
  serverSettings,
  testQueryClient,
  workspace,
  WORKSPACE_ID,
} from "./phase6Fixtures.js";

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

function trashed(id: string, title: string, trashedAt: number): ResearchTreeSummary {
  return summary({ id, title, workspaceId: WORKSPACE_ID, runningCount: 0, trashedAt });
}

const NOW = 1_700_000_000_000;

// jsdom has no layout; Home's virtualized list renders rows only within a
// viewport height, so this file gives it one (as `feed.test.tsx` does).
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

test("Trash rows name what they are and when they went, with Restore and Delete now", (t) => {
  const restored: string[] = [];
  const deleted: string[] = [];
  const entries: ResearchTrashEntry[] = [
    {
      kind: "folder",
      id: "f1",
      title: "Papers",
      trashedAt: NOW - 60_000,
      folder: { id: "f1", name: "Papers", workspaceId: WORKSPACE_ID, trashedAt: NOW - 60_000 },
    },
    {
      kind: "tree",
      id: "t1",
      title: "Old question",
      trashedAt: NOW - 120_000,
      tree: trashed("t1", "Old question", NOW - 120_000),
    },
  ];
  const view = render(
    <TrashList
      entries={entries}
      now={NOW}
      onRestore={(entry) => restored.push(entry.id)}
      onDeleteNow={(entry) => deleted.push(entry.id)}
    />,
  );
  const list = screen.getByRole("list", { name: "Items in the Trash" });
  t.regex(list.textContent ?? "", /Papers.*Folder · /);
  fireEvent.click(screen.getByRole("button", { name: "Restore Papers" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Old question now" }));
  t.deepEqual(restored, ["f1"]);
  t.deepEqual(deleted, ["t1"]);
  view.unmount();
  render(<TrashList entries={[]} onRestore={() => {}} onDeleteNow={() => {}} />);
  t.truthy(screen.getByText("The Trash is empty."));
});

test.serial("Move to Trash is the first step; Delete now asks again before deleting", async (t) => {
  const calls: string[] = [];
  render(
    <DeleteDialog
      trash={{
        title: "Delete “Notes”?",
        body: <p>It moves to the Trash, where you can restore it.</p>,
        onConfirm: () => {
          calls.push("trash");
        },
      }}
      remove={{ onConfirm: () => calls.push("remove") as unknown as void }}
      onClose={() => calls.push("close")}
    />,
  );
  const first = await screen.findByRole("dialog", { name: "Delete “Notes”?" });
  t.truthy(within(first).getByRole("button", { name: "Move to Trash" }));
  fireEvent.click(within(first).getByRole("button", { name: "Delete now" }));
  const second = await screen.findByRole("dialog", { name: "Delete permanently?" });
  t.regex(second.textContent ?? "", /This can’t be undone\./);
  fireEvent.click(within(second).getByRole("button", { name: "Delete" }));
  await waitUntil(t, () => calls.includes("close"), "the dialog closes after deleting");
  t.deepEqual(calls, ["remove", "close"]);
});

test.serial("active runs disable both steps and say why", async (t) => {
  render(
    <DeleteDialog
      trash={{ title: "Delete “Running”?", onConfirm: () => {} }}
      remove={{ onConfirm: () => {} }}
      disabledReason="It has active runs, which must finish or be cancelled before it can be deleted."
      onClose={() => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete “Running”?" });
  t.true(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Move to Trash" }).disabled);
  t.regex(within(dialog).getByRole("status").textContent ?? "", /active runs/);
});

test.serial("a refused delete keeps the dialog open with the reason", async (t) => {
  render(
    <DeleteDialog
      remove={{
        onConfirm: () => Promise.reject(new Error("research tree t1 has active runs")),
      }}
      onClose={() => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete permanently?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  t.is((await within(dialog).findByRole("alert")).textContent, "research tree t1 has active runs");
});

function trashResponses(): Record<string, unknown> {
  return {
    "workspaces.list": [workspace()],
    "settings.get": serverSettings(),
    "research.listTrees": [],
    "folders.get": folderState({
      folders: [{ id: "f1", name: "Papers", workspaceId: WORKSPACE_ID, trashedAt: NOW - 1 }],
    }),
    "folders.set": (input: { state: ResearchFolderState }) => input.state,
    "drafts.list": [],
    "research.listTrash": [trashed("t1", "Old question", NOW)],
    "research.restoreTreeFromTrash": { id: "t1", workspaceId: WORKSPACE_ID, title: "Old question" },
    "research.removeTree": { ok: true, treeIds: ["t1"] },
    "research.emptyTrash": { treeIds: ["t1"], folderIds: ["f1"] },
    "feed.recentQueriesForTrees": [],
  };
}

test.serial("the Trash view restores a thread and a folder", async (t) => {
  const app = await renderApp("/trash", {
    queryClient: testQueryClient(),
    responses: trashResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Restore Old question" }) !== null,
    "the rows",
  );
  t.truthy(screen.getByRole("heading", { name: "Trash", level: 1 }));
  fireEvent.click(screen.getByRole("button", { name: "Restore Old question" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.restoreTreeFromTrash"),
    "the thread is restored",
  );
  await waitUntil(
    t,
    () => useNotificationsStore.getState().items.some((item) => item.title === "Restored."),
    "the desktop's toast",
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore Papers" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "folders.set"),
    "the folder is restored",
  );
  const saved = app.trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.is(saved.state.folders[0]?.trashedAt, undefined);
  app.unmount();
});

test.serial("Delete now in the Trash asks once and deletes the thread", async (t) => {
  const app = await renderApp("/trash", {
    queryClient: testQueryClient(),
    responses: trashResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Delete Old question now" }) !== null,
    "the rows",
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete Old question now" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete permanently?" });
  t.regex(dialog.textContent ?? "", /“Old question” will be deleted\. This can’t be undone\./);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.removeTree"),
    "deleted",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.removeTree")?.input, {
    treeId: "t1",
  });
  app.unmount();
});

test.serial("Empty Trash counts what it deletes and empties the workspace's Trash", async (t) => {
  const app = await renderApp("/trash", {
    queryClient: testQueryClient(),
    responses: trashResponses(),
  });
  await waitUntil(
    t,
    () => !screen.getByRole<HTMLButtonElement>("button", { name: "Empty Trash" }).disabled,
    "Empty Trash is enabled",
  );
  fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
  const dialog = await screen.findByRole("dialog", { name: "Empty the Trash?" });
  t.regex(dialog.textContent ?? "", /2 items will be deleted\./);
  fireEvent.click(within(dialog).getByRole("button", { name: "Empty Trash" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.emptyTrash"),
    "emptied",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.emptyTrash")?.input, {
    workspaceId: WORKSPACE_ID,
  });
  app.unmount();
});

test.serial("a card's Delete moves its thread to the Trash, once for a parent", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...trashResponses(),
      "research.listTrees": [
        summary({ id: "p", title: "Parent", workspaceId: WORKSPACE_ID, runningCount: 0 }),
        summary({ id: "c", title: "Child", workspaceId: WORKSPACE_ID, runningCount: 0 }),
      ],
      "folders.get": folderState({ parents: { c: "p" } }),
      "research.listTrash": [],
      "feed.recentQueriesForTrees": [
        researchQuery({ treeId: "p", nodeId: "p-root", prompt: "Parent" }),
        researchQuery({ treeId: "c", nodeId: "c-root", prompt: "Child" }),
      ],
      "research.trashTree": { id: "p", workspaceId: WORKSPACE_ID, title: "Parent", trashedAt: NOW },
    },
  });
  await waitUntil(
    t,
    () => screen.queryAllByRole("button", { name: "Thread actions" }).length > 0,
    "the cards",
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Thread actions" })[0] as HTMLElement);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete “Parent” and its 1 child?" });
  t.regex(dialog.textContent ?? "", /Restoring it restores its child too\./);
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.trashTree"),
    "moved to the Trash",
  );
  t.deepEqual(
    app.trpc.calls.filter((call) => call.path === "research.trashTree").map((call) => call.input),
    [{ treeId: "p" }],
    "the server takes the child with its parent",
  );
  await waitUntil(
    t,
    () => screen.queryAllByRole("button", { name: "Undo" }).length > 0,
    "the toast offers Undo",
  );
  app.unmount();
});
