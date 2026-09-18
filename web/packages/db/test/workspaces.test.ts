import test from "ava";

import { nodes, preferences, trees, workspaces } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

test("workspaces are ordered, renamed, and scoped to their account", (t) => {
  const fixture = createFixture(t);
  const second = workspaces.create(fixture.db, fixture.userId, "Reading");
  const other = addUser(fixture.db, "other");
  const listed = workspaces.list(fixture.db, fixture.userId);
  t.deepEqual(
    listed.map((workspace) => workspace.name),
    ["Research", "Reading"],
  );
  t.is(workspaces.get(fixture.db, fixture.userId, other.workspaceId), null);
  t.is(workspaces.rename(fixture.db, fixture.userId, second.id, "  Notes  ").name, "Notes");
  t.throws(() => workspaces.rename(fixture.db, fixture.userId, second.id, "   "), {
    message: /needs a name/,
  });
  t.throws(() => workspaces.rename(fixture.db, fixture.userId, other.workspaceId, "x"), {
    message: /was not found/,
  });
});

test("reorder rejects a stale list, a duplicate, and a foreign workspace", (t) => {
  const fixture = createFixture(t);
  const second = workspaces.create(fixture.db, fixture.userId, "Reading");
  const other = addUser(fixture.db, "other");
  t.throws(() => workspaces.reorder(fixture.db, fixture.userId, [second.id]), {
    message: /stale/,
  });
  t.throws(() => workspaces.reorder(fixture.db, fixture.userId, [second.id, second.id]), {
    message: /duplicate/,
  });
  t.throws(() => workspaces.reorder(fixture.db, fixture.userId, [second.id, other.workspaceId]), {
    message: /not in this account/,
  });
  const reordered = workspaces.reorder(fixture.db, fixture.userId, [
    second.id,
    fixture.workspaceId,
  ]);
  t.deepEqual(
    reordered.map((workspace) => workspace.id),
    [second.id, fixture.workspaceId],
  );
});

test("removing a workspace is refused while a run is active", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Why do birds sing at dawn?",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  t.throws(() => workspaces.remove(fixture.db, fixture.userId, fixture.workspaceId), {
    message: /cancel the workspace's active research/,
  });
  nodes.setStatus(fixture.db, fixture.userId, rootId, "cancelled");
  const removal = workspaces.remove(fixture.db, fixture.userId, fixture.workspaceId);
  t.deepEqual(removal.removedTreeIds, [detail.tree.id]);
  t.is(workspaces.get(fixture.db, fixture.userId, fixture.workspaceId), null);
  t.deepEqual(trees.summaries(fixture.db, fixture.userId), []);
});

test("removing a workspace deletes a whole subtree of nodes", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
    status: "complete",
  });
  const rootId = detail.tree.rootNodeId;
  const child = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: rootId,
    prompt: "Child",
  });
  nodes.setStatus(fixture.db, fixture.userId, child.id, "complete");
  nodes.admitChild(fixture.db, fixture.userId, { parentNodeId: child.id, prompt: "Grandchild" });
  nodes.setStatus(
    fixture.db,
    fixture.userId,
    nodes.listActive(fixture.db, fixture.userId)[0]?.id ?? "",
    "cancelled",
  );
  workspaces.remove(fixture.db, fixture.userId, fixture.workspaceId);
  const remaining = fixture.db.$client.prepare(`SELECT count(*) AS n FROM nodes`).get();
  t.deepEqual(remaining, { n: 0 });
});

test("ensureDefault creates one workspace and setDefault records the choice", (t) => {
  const fixture = createFixture(t);
  const chosen = workspaces.ensureDefault(fixture.db, fixture.userId);
  t.is(chosen.id, fixture.workspaceId);
  const second = workspaces.create(fixture.db, fixture.userId, "Reading");
  t.is(workspaces.setDefault(fixture.db, fixture.userId, second.id).id, second.id);
  t.is(workspaces.ensureDefault(fixture.db, fixture.userId).id, second.id);
  // A default pointing at a removed workspace falls back rather than failing.
  workspaces.remove(fixture.db, fixture.userId, second.id);
  t.is(preferences.ensure(fixture.db, fixture.userId).defaultWorkspaceId, null);
  t.is(workspaces.ensureDefault(fixture.db, fixture.userId).id, fixture.workspaceId);
});

test("an account with no workspace gets one", (t) => {
  const fixture = createFixture(t);
  workspaces.remove(fixture.db, fixture.userId, fixture.workspaceId);
  const created = workspaces.ensureDefault(fixture.db, fixture.userId);
  t.is(created.name, workspaces.DEFAULT_WORKSPACE_NAME);
  t.is(workspaces.list(fixture.db, fixture.userId).length, 1);
});
