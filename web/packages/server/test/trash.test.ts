// The Trash and the folder state over tRPC: the procedures, their error codes
// and the events they publish (`03-api-and-events.md` §2, §3).

import type { SessionEvent } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";

/** Records every event the procedures publish, per user or to everyone. */
function recordEvents(harness: Harness): SessionEvent[] {
  const seen: SessionEvent[] = [];
  const emit = harness.eventBus.emit.bind(harness.eventBus);
  const emitAll = harness.eventBus.emitAll.bind(harness.eventBus);
  harness.eventBus.emit = (userId, event) => {
    seen.push(event);
    emit(userId, event);
  };
  harness.eventBus.emitAll = (event) => {
    seen.push(event);
    emitAll(event);
  };
  return seen;
}

function summary(events: readonly SessionEvent[]): [string, Record<string, unknown>][] {
  return events
    .filter((event) => event.type.startsWith("research."))
    .map((event) => [event.type, event.payload]);
}

async function setup(t: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(t);
  const user = harness.addUser("trasher");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const post = async (text: string) =>
    (
      await caller.research.importReport({
        markdown: `# ${text}`,
        prompt: text,
        workspaceId: workspace.id,
      })
    ).tree;
  return { harness, user, caller, workspace, post };
}

test("trashing, restoring and emptying publish the desktop's events", async (t) => {
  const { harness, user, caller, workspace, post } = await setup(t);
  const kept = await post("Kept");
  const tree = await post("Binned");
  const events = recordEvents(harness);

  const trashed = await caller.research.trashTree({ treeId: tree.id });
  t.not(trashed.trashedAt, null);
  t.deepEqual(summary(events), [
    ["research.tree.removed", { treeId: tree.id, removedBy: user.id }],
    ["research.trash.changed", { workspaceId: workspace.id }],
  ]);
  t.true(events.some((event) => event.type === "feed.item.removed"));
  t.deepEqual(
    (await caller.research.listTrees({ workspaceId: workspace.id })).map((item) => item.id),
    [kept.id],
  );
  t.deepEqual(
    (await caller.research.listTrash({ workspaceId: workspace.id })).map((item) => item.id),
    [tree.id],
  );

  events.length = 0;
  await caller.research.trashTree({ treeId: tree.id });
  t.deepEqual(summary(events), [], "trashing again publishes nothing");

  const restored = await caller.research.restoreTreeFromTrash({ treeId: tree.id });
  t.is(restored.trashedAt, null);
  t.deepEqual(summary(events), [
    ["research.tree.restored", { tree: restored }],
    ["research.trash.changed", { workspaceId: workspace.id }],
  ]);
  t.true(events.some((event) => event.type === "feed.item.upserted"));

  await caller.research.trashTree({ treeId: tree.id });
  await caller.folders.set({
    workspaceId: workspace.id,
    state: {
      folders: [{ id: "f1", name: "Old", workspaceId: workspace.id, trashedAt: 1 }],
      membership: {},
      collapsed: [],
      parents: {},
      collapsedGroups: [],
    },
  });
  events.length = 0;
  const emptied = await caller.research.emptyTrash({ workspaceId: workspace.id });
  t.deepEqual(emptied, { treeIds: [tree.id], folderIds: ["f1"] });
  t.deepEqual(summary(events), [
    ["research.tree.removed", { treeId: tree.id, removedBy: user.id }],
    ["research.folders.changed", { workspaceId: workspace.id }],
    ["research.trash.changed", { workspaceId: workspace.id }],
  ]);
  t.deepEqual(await caller.research.listTrash({ workspaceId: workspace.id }), []);
  t.deepEqual((await caller.folders.get({ workspaceId: workspace.id })).folders, []);
});

test("Delete from the Trash removes the thread and refreshes the Trash", async (t) => {
  const { harness, user, caller, workspace, post } = await setup(t);
  const tree = await post("Binned");
  await caller.research.trashTree({ treeId: tree.id });
  const events = recordEvents(harness);
  const removed = await caller.research.removeTree({ treeId: tree.id });
  t.deepEqual(removed, { ok: true, treeIds: [tree.id] });
  t.deepEqual(summary(events), [
    ["research.tree.removed", { treeId: tree.id, removedBy: user.id }],
    ["research.trash.changed", { workspaceId: workspace.id }],
  ]);
  const missing = await t.throwsAsync<TRPCError>(caller.research.removeTree({ treeId: tree.id }));
  t.is(missing.code, "NOT_FOUND");
});

test("a thread in the Trash refuses edits, and one with a run refuses the Trash", async (t) => {
  const { caller, workspace, post } = await setup(t);
  const tree = await post("Binned");
  await caller.research.trashTree({ treeId: tree.id });
  const refused = await t.throwsAsync<TRPCError>(
    caller.research.renameTree({ treeId: tree.id, title: "New" }),
  );
  t.is(refused.code, "PRECONDITION_FAILED");
  t.is(refused.message, "restore this research from the Trash before changing it");
  const archive = await t.throwsAsync<TRPCError>(caller.research.archiveTree({ treeId: tree.id }));
  t.is(archive.code, "PRECONDITION_FAILED");

  const running = await caller.research.createTree({
    prompt: "Still running",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const busy = await t.throwsAsync<TRPCError>(
    caller.research.trashTree({ treeId: running.tree.id }),
  );
  t.is(busy.code, "PRECONDITION_FAILED");
  t.regex(busy.message, /active runs/);
});

test("the Trash is private to its owner", async (t) => {
  const { harness, caller, workspace, post } = await setup(t);
  const tree = await post("Mine");
  await caller.research.trashTree({ treeId: tree.id });
  const stranger = harness.caller(harness.addUser("trash-stranger"));
  const foreign = await t.throwsAsync<TRPCError>(
    stranger.research.restoreTreeFromTrash({ treeId: tree.id }),
  );
  t.is(foreign.code, "NOT_FOUND");
  t.deepEqual(await stranger.research.listTrash({ workspaceId: workspace.id }), []);
  t.deepEqual(await stranger.research.emptyTrash({ workspaceId: workspace.id }), {
    treeIds: [],
    folderIds: [],
  });
  t.is((await caller.research.listTrash({ workspaceId: workspace.id })).length, 1);
  const guest = await t.throwsAsync<TRPCError>(
    harness.caller(null).research.listTrash({ workspaceId: workspace.id }),
  );
  t.is(guest.code, "UNAUTHORIZED");
});

test("folders.set publishes research.folders.changed only when the state changed", async (t) => {
  const { harness, caller, workspace, post } = await setup(t);
  const parent = await post("Parent");
  const child = await post("Child");
  const events = recordEvents(harness);
  const next = {
    folders: [{ id: "f1", name: "Reading", workspaceId: workspace.id }],
    membership: { [parent.id]: "f1", [child.id]: "f1" },
    collapsed: ["system:drafts"],
    parents: { [child.id]: parent.id },
    collapsedGroups: [parent.id],
  };
  const stored = await caller.folders.set({ workspaceId: workspace.id, state: next });
  t.deepEqual(stored.parents, { [child.id]: parent.id });
  t.deepEqual(stored.collapsedGroups, [parent.id]);
  t.deepEqual(summary(events), [["research.folders.changed", { workspaceId: workspace.id }]]);
  events.length = 0;
  await caller.folders.set({ workspaceId: workspace.id, state: next });
  t.deepEqual(summary(events), []);

  const invalid = await t.throwsAsync<TRPCError>(
    caller.folders.set({
      workspaceId: workspace.id,
      state: { ...next, folders: [{ id: "f2", name: "Archive", workspaceId: workspace.id }] },
    }),
  );
  t.is(invalid.code, "BAD_REQUEST");
  t.is(invalid.message, 'The name "Archive" is reserved.');

  // Archiving the parent takes its child.
  events.length = 0;
  await caller.research.archiveTree({ treeId: parent.id });
  t.deepEqual(
    summary(events).map(([type, payload]) => [type, (payload["tree"] as { id: string }).id]),
    [
      ["research.tree.archived", child.id],
      ["research.tree.archived", parent.id],
    ],
  );
});
