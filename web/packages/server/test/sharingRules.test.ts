// Collaboration rules through the procedures (review round 3): stalled
// chains, owner-archived threads, invitations, readers who lose a thread,
// presence, who a public reader sees, notifications, per-workspace member
// Trash, deleting groups, and stopping a departed member's interrupted run.

import { nodes, schema, sharing as sharingRepo } from "@session/db";
import type { TRPCError } from "@trpc/server";
import test from "ava";
import { eq } from "drizzle-orm";

import { DEPARTED_ASKER_STOPPED } from "../src/trpc/routers/research/common.js";

import { runOf } from "./helpers.js";
import { listen, settle, sharedThread } from "./threadHelpers.js";

test("a follow-up behind someone else's stopped answer names who can retry it", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const asked = await harness
    .caller(thread.commenter)
    .followups.ask({ headNodeId: thread.rootId, prompt: "And a cuckoo filter?" });
  if (asked.kind !== "sent") return t.fail();
  nodes.setStatus(harness.db, thread.commenter.id, asked.node.id, "cancelled");
  const refused = await t.throwsAsync<TRPCError>(
    harness.caller(thread.owner).followups.ask({ headNodeId: thread.rootId, prompt: "Next?" }),
  );
  t.is(refused.code, "PRECONDITION_FAILED");
  t.is(
    refused.message,
    `The last answer stopped. Only ${thread.commenter.login} can retry it. Delete it, or branch from the answer before it to continue.`,
  );
  const own = await t.throwsAsync<TRPCError>(
    harness.caller(thread.commenter).followups.ask({ headNodeId: thread.rootId, prompt: "Next?" }),
  );
  t.is(own.message, "The last answer was stopped. Run it again to continue.");
});

test("a member cannot unarchive a thread its owner archived", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const commenter = listen(harness, thread.commenter);
  await harness.caller(thread.owner).research.archiveTree({ treeId: thread.treeId });
  await settle();
  // The per-person marker is the reader's own: never in another's event.
  const archived = commenter.of("research.tree.archived")[0]?.payload["tree"] as
    Record<string, unknown> | undefined;
  t.false(archived !== undefined && "archivedBy" in archived);
  const member = harness.caller(thread.commenter);
  t.is((await member.research.getTree({ treeId: thread.treeId })).tree.archivedBy, "owner");
  t.is((await member.sharing.listShared({ place: "archive" }))[0]?.archivedBy, "owner");
  const refused = await t.throwsAsync<TRPCError>(
    member.research.restoreTree({ treeId: thread.treeId }),
  );
  t.is(refused.code, "PRECONDITION_FAILED");
  t.is(refused.message, "This thread was archived by its owner; only they can unarchive it.");
});

test("inviting a member is refused; inviting a login again renews it quietly", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = harness.caller(thread.owner);
  const member = await t.throwsAsync<TRPCError>(
    owner.invites.create({
      treeId: thread.treeId,
      role: "commenter",
      githubLogin: thread.commenter.login,
    }),
  );
  t.is(member.code, "PRECONDITION_FAILED");
  t.is(member.message, `@${thread.commenter.login} already has access to this thread.`);

  const stranger = listen(harness, thread.stranger);
  const first = await owner.invites.create({
    treeId: thread.treeId,
    role: "viewer",
    githubLogin: thread.stranger.login,
  });
  const second = await owner.invites.create({
    treeId: thread.treeId,
    role: "commenter",
    githubLogin: thread.stranger.login,
  });
  await settle();
  t.is(second.invite.id, first.invite.id);
  t.is(stranger.of("notification.requested").length, 1, "one notification for one invitation");
  t.is(stranger.of("research.invites.changed").length, 2);
  t.deepEqual(
    (await harness.caller(thread.stranger).invites.received()).map((invite) => invite.role),
    ["commenter"],
  );
});

test("accepting an invitation brings a thread back from the member's Trash", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const member = harness.caller(thread.commenter);
  await member.research.trashTree({ treeId: thread.treeId });
  t.deepEqual(await member.sharing.listShared(), []);
  const link = await harness
    .caller(thread.owner)
    .invites.create({ treeId: thread.treeId, role: "commenter" });
  const events = listen(harness, thread.commenter);
  await member.invites.accept({ token: link.token });
  await settle();
  t.is(events.of("research.sharing.changed").length, 1);
  t.deepEqual(
    (await member.sharing.listShared()).map((summary) => summary.id),
    [thread.treeId],
  );
});

test("readers of a public thread who are not members are told when they lose it", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = harness.caller(thread.owner);
  await owner.sharing.setVisibility({ treeId: thread.treeId, visibility: "public" });
  const reader = listen(harness, thread.stranger);
  await harness.caller(thread.stranger).events.setInterest({
    connectionId: reader.connectionId,
    nodeIds: [],
    treeIds: [thread.treeId],
  });
  t.true(harness.eventBus.viewers(thread.treeId).some((v) => v.userId === thread.stranger.id));

  await owner.sharing.setVisibility({ treeId: thread.treeId, visibility: "private" });
  await settle();
  t.deepEqual(reader.of("research.sharing.changed")[0]?.payload, { treeId: thread.treeId });
  t.false(harness.eventBus.viewers(thread.treeId).some((v) => v.userId === thread.stranger.id));
  // Their declaration is gone: making it public again does not resume
  // delivery until they open it again.
  await owner.sharing.setVisibility({ treeId: thread.treeId, visibility: "public" });
  reader.clear();
  await owner.research.renameTree({ treeId: thread.treeId, title: "Renamed" });
  await settle();
  t.deepEqual(reader.of("research.tree.updated"), []);

  // Open again; the owner moves it to the Trash, then deletes it.
  await harness.caller(thread.stranger).events.setInterest({
    connectionId: reader.connectionId,
    nodeIds: [],
    treeIds: [thread.treeId],
  });
  await owner.research.trashTree({ treeId: thread.treeId });
  await settle();
  t.deepEqual(reader.of("research.tree.removed")[0]?.payload, {
    treeId: thread.treeId,
    removedBy: thread.owner.id,
    trashed: true,
  });
});

test("deleting a public thread tells the readers who had it open", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = harness.caller(thread.owner);
  await owner.sharing.setVisibility({ treeId: thread.treeId, visibility: "public" });
  const reader = listen(harness, thread.stranger);
  await harness.caller(thread.stranger).events.setInterest({
    connectionId: reader.connectionId,
    nodeIds: [],
    treeIds: [thread.treeId],
  });
  await owner.research.removeTree({ treeId: thread.treeId });
  await settle();
  t.deepEqual(reader.of("research.tree.removed")[0]?.payload, {
    treeId: thread.treeId,
    removedBy: thread.owner.id,
  });
});

test("deleting a parent tells the members of the children that went with it", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = harness.caller(thread.owner);
  const workspace = await owner.workspaces.ensureDefault();
  const parent = await owner.research.createPost({
    body: "A parent note",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  // The shared thread is listed under the parent (one level of nesting).
  harness.db
    .update(schema.trees)
    .set({ parentTreeId: parent.tree.id })
    .where(eq(schema.trees.id, thread.treeId))
    .run();
  const commenter = listen(harness, thread.commenter);
  const removed = await owner.research.removeTree({ treeId: parent.tree.id });
  t.deepEqual([...removed.treeIds].sort(), [parent.tree.id, thread.treeId].sort());
  await settle();
  t.deepEqual(
    commenter.of("research.tree.removed").map((event) => event.payload["treeId"]),
    [thread.treeId],
  );
});

test("a public reader sees the owner and the members who wrote something", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  await harness
    .caller(thread.owner)
    .sharing.setVisibility({ treeId: thread.treeId, visibility: "public" });
  await harness
    .caller(thread.commenter)
    .research.forkNode({ parentNodeId: thread.rootId, prompt: "A branch" });
  const ids = async (caller: ReturnType<typeof harness.caller>) =>
    (await caller.sharing.listMembers({ treeId: thread.treeId })).map((member) => member.userId);
  t.deepEqual(await ids(harness.caller(thread.stranger)), [thread.owner.id, thread.commenter.id]);
  t.deepEqual(await ids(harness.caller(thread.viewer)), [
    thread.owner.id,
    thread.commenter.id,
    thread.viewer.id,
  ]);
  const detail = await harness.caller(null).research.getTree({ treeId: thread.treeId });
  t.deepEqual(
    detail.participants?.map((person) => person.id),
    [thread.owner.id, thread.commenter.id],
  );
});

test("nobody is notified about a thread they can no longer read", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  // The commenter's answer, branched from after they were removed.
  const asked = await harness
    .caller(thread.commenter)
    .research.forkNode({ parentNodeId: thread.rootId, prompt: "The commenter's question" });
  nodes.setStatus(harness.db, thread.commenter.id, asked.id, "complete");
  await harness.caller(thread.viewer).subscriptions.set({ treeId: thread.treeId, value: true });
  await harness
    .caller(thread.owner)
    .sharing.removeMember({ treeId: thread.treeId, userId: thread.commenter.id });
  await harness
    .caller(thread.owner)
    .sharing.removeMember({ treeId: thread.treeId, userId: thread.viewer.id });
  const commenter = listen(harness, thread.commenter);
  const viewer = listen(harness, thread.viewer);
  await harness
    .caller(thread.owner)
    .research.forkNode({ parentNodeId: asked.id, prompt: "The owner's branch" });
  await settle();
  t.deepEqual(commenter.of("notification.requested"), [], "no branch notification");
  t.deepEqual(viewer.of("notification.requested"), [], "no follow-up notification");
});

test("a member's Trash is per workspace through the procedures", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const member = harness.caller(thread.commenter);
  const home = await member.workspaces.ensureDefault();
  const second = await member.workspaces.create({ name: "Second" });
  const events = listen(harness, thread.commenter);
  await member.research.trashTree({ treeId: thread.treeId, workspaceId: second.id });
  await settle();
  t.deepEqual(events.of("research.trash.changed")[0]?.payload, { workspaceId: second.id });
  t.deepEqual(
    (await member.sharing.listShared({ place: "trash", workspaceId: second.id })).map((s) => s.id),
    [thread.treeId],
  );
  t.deepEqual(await member.sharing.listShared({ place: "trash", workspaceId: home.id }), []);
  // Empty Trash elsewhere leaves it alone.
  t.deepEqual(await member.research.emptyTrash({ workspaceId: home.id }), {
    treeIds: [],
    folderIds: [],
  });
  t.deepEqual(await member.research.emptyTrash({ workspaceId: second.id }), {
    treeIds: [thread.treeId],
    folderIds: [],
  });
});

test("Empty Trash succeeds for a member after the owner trashed the thread too", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const member = harness.caller(thread.commenter);
  const home = await member.workspaces.ensureDefault();
  await member.research.trashTree({ treeId: thread.treeId });
  await harness.caller(thread.owner).research.trashTree({ treeId: thread.treeId });
  t.deepEqual(await member.research.emptyTrash({ workspaceId: home.id }), {
    treeIds: [thread.treeId],
    folderIds: [],
  });
  t.is(sharingRepo.memberIds(harness.db, thread.treeId).includes(thread.commenter.id), false);
});

test("a member who leaves stops their interrupted question for good", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const asked = await harness
    .caller(thread.commenter)
    .research.forkNode({ parentNodeId: thread.rootId, prompt: "Interrupted question" });
  nodes.setStatus(harness.db, thread.commenter.id, asked.id, "running");
  nodes.markInterrupted(harness.db, thread.commenter.id, asked.id);
  await harness.caller(thread.commenter).sharing.leave({ treeId: thread.treeId });
  const node = nodes.get(harness.db, thread.owner.id, asked.id);
  t.is(runOf(node).status, "cancelled");
  t.is(runOf(node).error, DEPARTED_ASKER_STOPPED);
  t.false(runOf(node).resumePending === true);
  t.is(
    harness.db.$client.prepare("SELECT 1 FROM run_queue WHERE node_id = ?").get(asked.id),
    undefined,
  );
});

test("Stop ends an interrupted question that is waiting to resume", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const asked = await harness
    .caller(thread.commenter)
    .research.forkNode({ parentNodeId: thread.rootId, prompt: "Interrupted question" });
  nodes.setStatus(harness.db, thread.commenter.id, asked.id, "running");
  nodes.markInterrupted(harness.db, thread.commenter.id, asked.id);
  const stopped = await harness.caller(thread.commenter).research.cancelNode({ nodeId: asked.id });
  t.is(runOf(stopped).status, "cancelled");
  t.true(harness.runs.cancelled.includes(asked.id));
  const again = await t.throwsAsync<TRPCError>(
    harness.caller(thread.commenter).research.cancelNode({ nodeId: asked.id }),
  );
  t.is(again.code, "PRECONDITION_FAILED");
});
