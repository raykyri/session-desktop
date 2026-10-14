// Shared threads through the procedures: invitations, who receives which
// events, presence, notifications, who pays, stale edits, and images
// (`03-api-and-events.md` §2–§3, `02-domain-model-and-database.md` §5.16).

import { followups, nodes, schema, snapshots } from "@session/db";
import type { ResearchImageAttachment } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";
import sharp from "sharp";

import { sessionEvent } from "../src/events/bus.js";
import { AUTHOR_MAY_NOT_ASK, dispatchTree } from "../src/research/followups.js";
import { notifyRunFinished } from "../src/research/notifications.js";

import type { Harness } from "./helpers.js";
import { anchorFor, answerTurn, createHarness } from "./helpers.js";
import type { Thread } from "./threadHelpers.js";
import { listen, settle, sharedThread } from "./threadHelpers.js";

test("an invitation by login notifies its account, and accepting it tells the owner", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("invite-owner");
  const invitee = harness.addUser("invite-target");
  const ownerEvents = listen(harness, owner);
  const inviteeEvents = listen(harness, invitee);
  const caller = harness.caller(owner);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: "A note to share",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const created = await caller.invites.create({
    treeId: detail.tree.id,
    role: "commenter",
    githubLogin: "Invite-Target",
  });
  await settle();
  const notification = inviteeEvents.of("notification.requested")[0]?.payload;
  t.is(notification?.["kind"], "invite");
  t.is(notification?.["href"], "/shared");
  t.is(notification?.["treeId"], detail.tree.id);
  t.true(inviteeEvents.types().includes("research.invites.changed"));
  // Not readable until accepted.
  await t.throwsAsync(harness.caller(invitee).research.getTree({ treeId: detail.tree.id }), {
    message: /not found/,
  });
  const tree = await harness.caller(invitee).invites.accept({ inviteId: created.invite.id });
  t.is(tree.role, "commenter");
  await settle();
  t.true(ownerEvents.of("research.sharing.changed").length > 0);
  t.deepEqual(
    (await caller.sharing.listMembers({ treeId: detail.tree.id })).map((member) => member.login),
    ["invite-owner", "invite-target"],
  );
  t.deepEqual(
    (await harness.caller(invitee).sharing.listShared()).map((summary) => summary.id),
    [detail.tree.id],
  );
  await t.throwsAsync<TRPCError>(
    harness.caller(invitee).invites.accept({ inviteId: created.invite.id }),
    { message: /^This invitation was not found/ },
  );
});

test("a thread's events reach its audience and nobody else", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = listen(harness, thread.owner);
  const commenter = listen(harness, thread.commenter);
  const viewer = listen(harness, thread.viewer);
  const stranger = listen(harness, thread.stranger);
  await settle();
  for (const connection of [owner, commenter, viewer, stranger]) connection.clear();

  const node = await harness.caller(thread.commenter).research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "How many hash functions?",
  });
  await settle();
  for (const connection of [owner, commenter, viewer]) {
    t.true(connection.types().includes("research.node.created"));
  }
  t.false(stranger.types().some((type) => type.startsWith("research.")));
  // A private thread's feed card is the owner's alone.
  t.false(stranger.types().includes("feed.item.upserted"));

  // Run deltas still go only to connections interested in the node.
  harness.eventBus.setInterest(thread.viewer.id, viewer.connectionId, [node.id]);
  harness.eventBus.emitToTree(
    thread.treeId,
    sessionEvent("research.turn.delta", { nodeId: node.id, seq: 1, turnId: "x", text: "hi" }),
  );
  await settle();
  t.true(viewer.types().includes("research.turn.delta"));
  t.false(owner.types().includes("research.turn.delta"));

  // Per-person state stays with the person.
  for (const connection of [owner, commenter, viewer, stranger]) connection.clear();
  await harness.caller(thread.viewer).research.markTreeViewed({ treeId: thread.treeId });
  await settle();
  t.true(viewer.types().includes("research.tree.updated"));
  t.false(owner.types().includes("research.tree.updated"));

  // A thread-level rename reaches everyone, without the owner's own fields.
  await harness.caller(thread.owner).research.renameTree({ treeId: thread.treeId, title: "Bloom" });
  await settle();
  const renamed = commenter.of("research.tree.updated")[0]?.payload["tree"] as
    Record<string, unknown> | undefined;
  t.is(renamed?.["title"], "Bloom");
  t.false(renamed !== undefined && "role" in renamed);

  // A public thread reaches a signed-in reader who opened it, and only then.
  await harness.caller(thread.owner).sharing.setVisibility({
    treeId: thread.treeId,
    visibility: "public",
  });
  await settle();
  t.true(stranger.types().includes("feed.item.upserted"));
  stranger.clear();
  await harness.caller(thread.owner).research.renameTree({ treeId: thread.treeId, title: "B" });
  await settle();
  t.false(stranger.types().includes("research.tree.updated"));
  await harness.caller(thread.stranger).events.setInterest({
    connectionId: stranger.connectionId,
    nodeIds: [],
    treeIds: [thread.treeId],
  });
  await harness.caller(thread.owner).research.renameTree({ treeId: thread.treeId, title: "C" });
  await settle();
  t.true(stranger.types().includes("research.tree.updated"));
  for (const connection of [owner, commenter, viewer, stranger]) connection.close();
});

test("presence lists who has a thread open and drops a closed connection", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = listen(harness, thread.owner);
  const commenter = listen(harness, thread.commenter);
  await harness.caller(thread.commenter).events.setInterest({
    connectionId: commenter.connectionId,
    nodeIds: [],
    treeIds: [thread.treeId],
  });
  await settle();
  const announced = owner.of("research.presence.changed").at(-1)?.payload;
  t.deepEqual(
    (announced?.["viewers"] as { login: string }[] | undefined)?.map((viewer) => viewer.login),
    ["thread-commenter"],
  );
  t.deepEqual(
    (await harness.caller(thread.owner).events.presence({ treeId: thread.treeId })).map(
      (viewer) => viewer.userId,
    ),
    [thread.commenter.id],
  );
  // A thread the caller may not read is not declared open.
  const stranger = listen(harness, thread.stranger);
  await harness.caller(thread.stranger).events.setInterest({
    connectionId: stranger.connectionId,
    nodeIds: [],
    treeIds: [thread.treeId],
  });
  t.deepEqual(
    harness.eventBus.viewers(thread.treeId).map((viewer) => viewer.userId),
    [thread.commenter.id],
  );
  commenter.close();
  await settle();
  t.deepEqual(owner.of("research.presence.changed").at(-1)?.payload["viewers"], []);
  owner.close();
  stranger.close();
});

test("followers, the parent's author and the asker are notified", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = listen(harness, thread.owner);
  const viewer = listen(harness, thread.viewer);
  const commenter = listen(harness, thread.commenter);
  const followed = await harness
    .caller(thread.viewer)
    .subscriptions.set({ treeId: thread.treeId, value: true });
  t.true(followed.followed ?? false);
  const node = await harness.caller(thread.commenter).research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "A branch from the owner's answer",
  });
  await settle();
  t.is(owner.of("notification.requested")[0]?.payload["kind"], "branch");
  t.is(viewer.of("notification.requested")[0]?.payload["kind"], "followUp");
  t.is(commenter.of("notification.requested").length, 0, "nobody hears of their own question");
  // The asker hears that their run finished.
  const settled = {
    ...node,
    run: { ...(node.type === "exchange" ? node.run : {}), status: "complete" },
  };
  notifyRunFinished(harness.deps, settled as typeof node);
  await settle();
  const finished = commenter.of("notification.requested")[0]?.payload;
  t.is(finished?.["kind"], "runFinished");
  t.is(finished?.["href"], `/r/${thread.treeId}?sel=${node.id}`);
  for (const connection of [owner, viewer, commenter]) connection.close();
});

test("the asker pays: a commenter's question is queued and limited as theirs", async (t) => {
  const thread = await sharedThread(t, { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "1" });
  const { harness } = thread;
  const node = await harness.caller(thread.commenter).research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "Paid by the commenter",
  });
  const row = harness.db
    .select()
    .from(schema.runQueue)
    .all()
    .find((candidate) => candidate.nodeId === node.id);
  t.is(row?.userId, thread.commenter.id);
  harness.db
    .insert(schema.runAttempts)
    .values({
      nodeId: node.id,
      attempt: 1,
      kind: "fresh",
      model: "gemini-flash",
      startedAt: Date.now(),
    })
    .run();
  // The commenter has spent their day; the owner has not.
  await t.throwsAsync<TRPCError>(
    harness.caller(thread.commenter).research.forkNode({
      parentNodeId: thread.rootId,
      prompt: "Over the commenter's limit",
    }),
    { message: /daily research limit/ },
  );
  await t.notThrowsAsync(
    harness.caller(thread.owner).research.forkNode({
      parentNodeId: thread.rootId,
      prompt: "The owner's own budget",
    }),
  );
  // A viewer is refused before any of it.
  await t.throwsAsync<TRPCError>(
    harness.caller(thread.viewer).followups.ask({ headNodeId: thread.rootId, prompt: "May I?" }),
    { message: /^Viewers of this thread/ },
  );
});

test("stale edits of shared content are CONFLICT", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const ownerCaller = harness.caller(thread.owner);
  const commenterCaller = harness.caller(thread.commenter);
  const note = await commenterCaller.research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "Inline",
    inline: true,
  });
  // Someone reordered the column since the caller read it.
  await ownerCaller.research.setChainOrder({
    headNodeId: thread.rootId,
    nodeIds: [note.id, thread.rootId],
    expectedOrder: [thread.rootId, note.id],
  });
  const stale = await t.throwsAsync<TRPCError>(
    ownerCaller.research.setChainOrder({
      headNodeId: thread.rootId,
      nodeIds: [thread.rootId, note.id],
      expectedOrder: [thread.rootId, note.id],
    }),
  );
  t.is(stale?.code, "CONFLICT");
  const recap = await t.throwsAsync<TRPCError>(
    commenterCaller.recaps.applyCandidate({
      nodeId: thread.rootId,
      expectedResponseRevision: thread.revision,
      expectedCurrentRecapId: "someone-elses-recap",
      candidate: {
        id: "cand",
        text: "A summary.",
        responseRevision: thread.revision,
        instructions: "Summarize.",
        generatedAt: Date.now(),
        adapter: "gemini",
        model: "gemini-flash",
      },
    }),
  );
  t.is(recap?.code, "CONFLICT");
  const workspace = await ownerCaller.workspaces.ensureDefault();
  const doc = await ownerCaller.research.importReport({
    markdown: "# Report\n\nBody.",
    prompt: "A report",
    workspaceId: workspace.id,
  });
  const document = await t.throwsAsync<TRPCError>(
    ownerCaller.research.updateDocument({
      nodeId: doc.tree.rootNodeId,
      markdown: "# Report\n\nNew body.",
      expectedTitle: doc.tree.title,
      expectedResponseRevision: "stale-revision",
    }),
  );
  t.is(document?.code, "CONFLICT");
  const post = await ownerCaller.research.createPost({
    body: "Shared note",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const note2 = await t.throwsAsync<TRPCError>(
    ownerCaller.research.updatePost({
      nodeId: post.tree.rootNodeId,
      text: "Edited",
      expectedText: "Not what it says",
    }),
  );
  t.is(note2?.code, "CONFLICT");
  // Highlights are refused against a stale answer the same way.
  const highlight = await t.throwsAsync<TRPCError>(
    commenterCaller.highlights.create({
      nodeId: thread.rootId,
      anchor: anchorFor(
        thread.revision.replace(/.$/, (last) => (last === "0" ? "1" : "0")),
        "bloom filter",
        2,
      ),
    }),
  );
  t.is(highlight?.code, "CONFLICT");
});

test("the owner's Trash hides the thread from members until Restore", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const commenter = listen(harness, thread.commenter);
  const trashed = await harness.caller(thread.owner).research.trashTree({ treeId: thread.treeId });
  t.is(trashed.trashedBy, thread.owner.id);
  await settle();
  t.deepEqual(commenter.of("research.tree.removed")[0]?.payload, {
    treeId: thread.treeId,
    removedBy: thread.owner.id,
    trashed: true,
  });
  await t.throwsAsync(
    harness.caller(thread.commenter).research.getTree({ treeId: thread.treeId }),
    {
      message: /not found/,
    },
  );
  await harness.caller(thread.owner).research.restoreTreeFromTrash({ treeId: thread.treeId });
  await settle();
  t.true(commenter.types().includes("research.sharing.changed"));
  t.is(
    (await harness.caller(thread.commenter).research.getTree({ treeId: thread.treeId })).tree.role,
    "commenter",
  );
  commenter.close();
});

test("removing a member stops their running question and tells them", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const node = await harness.caller(thread.commenter).research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "Still running",
  });
  const commenter = listen(harness, thread.commenter);
  await harness.caller(thread.owner).sharing.removeMember({
    treeId: thread.treeId,
    userId: thread.commenter.id,
  });
  await settle();
  t.true(harness.runs.cancelled.includes(node.id));
  t.true(commenter.types().includes("research.tree.removed"));
  const detail = await harness.caller(thread.owner).research.getTree({ treeId: thread.treeId });
  const stopped = detail.nodes.find((candidate) => candidate.id === node.id);
  t.is(stopped?.type === "exchange" ? stopped.run.status : null, "cancelled");
  t.is(stopped?.authorId, thread.commenter.id);
  commenter.close();
});

test("a removed member is FORBIDDEN from rejoining through an earlier link", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = harness.caller(thread.owner);
  const link = await owner.invites.create({ treeId: thread.treeId, role: "viewer" });
  await owner.sharing.removeMember({ treeId: thread.treeId, userId: thread.commenter.id });
  const error = await t.throwsAsync<TRPCError>(
    harness.caller(thread.commenter).invites.accept({ token: link.token }),
  );
  t.is(error?.code, "FORBIDDEN");
  t.is(error?.message, "You were removed from this thread.");
  // A stranger can still use it.
  const joined = await harness.caller(thread.stranger).invites.accept({ token: link.token });
  t.is(joined.role, "viewer");
});

test("a thread's images are readable by whoever may read the thread", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("image-owner");
  const member = harness.addUser("image-member");
  const stranger = harness.addUser("image-stranger");
  const ownerCookie = harness.signIn(owner);
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#3366cc" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
  const response = await harness.request("/api/images", {
    method: "POST",
    body: form,
    cookie: ownerCookie,
  });
  const image = (await response.json()) as ResearchImageAttachment;
  const caller = harness.caller(owner);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is in this picture?",
    model: "gemini-flash",
    workspaceId: workspace.id,
    images: [image.id],
  });
  const invite = await caller.invites.create({ treeId: detail.tree.id, role: "viewer" });
  await harness.caller(member).invites.accept({ token: invite.token });
  const read = (cookie?: string) =>
    harness.request(`/images/${image.id}`, cookie === undefined ? {} : { cookie });
  t.is((await read(harness.signIn(member))).status, 200);
  t.is((await read(harness.signIn(stranger))).status, 404);
  t.is((await read()).status, 401);
  await caller.sharing.setVisibility({ treeId: detail.tree.id, visibility: "public" });
  t.is((await read(harness.signIn(stranger))).status, 200);
  t.is((await read()).status, 200);
});

/** Commits an answer for a node the recording run service never runs. */
function complete(harness: Harness, userId: string, nodeId: string): void {
  nodes.setStatus(harness.db, userId, nodeId, "running");
  snapshots.commit(harness.db, userId, {
    nodeId,
    turns: [answerTurn(nodeId, "An answer.")],
    outcome: { status: "complete" },
  });
}

/** The commenter's inline question under the root, still queued, and a
 * follow-up of theirs queued behind it. */
async function commenterQueue(thread: Thread) {
  const caller = thread.harness.caller(thread.commenter);
  const running = await caller.research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "How many hash functions?",
    inline: true,
  });
  const asked = await caller.followups.ask({ headNodeId: thread.rootId, prompt: "And deletes?" });
  if (asked.kind !== "queued") throw new Error("expected the follow-up to be queued");
  return { running, item: asked.item };
}

test("tree events carry no per-person fields to the rest of the audience", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("document-owner");
  const member = harness.addUser("document-member");
  const ownerCaller = harness.caller(owner);
  const workspace = await ownerCaller.workspaces.ensureDefault();
  const detail = await ownerCaller.research.importReport({
    markdown: "# Report\n\nBody text.",
    prompt: "A report",
    workspaceId: workspace.id,
  });
  const revision = snapshots.revision(harness.db, owner.id, detail.tree.rootNodeId) ?? "";
  const branch = await ownerCaller.research.forkNode({
    parentNodeId: detail.tree.rootNodeId,
    prompt: "What text?",
    anchor: { kind: "passage", anchor: anchorFor(revision, "Body text", 10) },
  });
  const link = await ownerCaller.invites.create({ treeId: detail.tree.id, role: "commenter" });
  await harness.caller(member).invites.accept({ token: link.token });
  // The member's own Archive is theirs.
  await harness.caller(member).research.archiveTree({ treeId: detail.tree.id });
  const ownerEvents = listen(harness, owner);
  const memberEvents = listen(harness, member);
  await ownerCaller.research.updateDocument({
    nodeId: detail.tree.rootNodeId,
    markdown: "# Report\n\nThe new Body text.",
    expectedTitle: detail.tree.title,
    expectedResponseRevision: revision,
    expectedHighlightIds: [],
  });
  await ownerCaller.research.renameTree({ treeId: detail.tree.id, title: "Renamed" });
  await settle();
  const PER_PERSON = ["role", "lastViewedAt", "followed", "archivedAt", "trashedAt", "trashedBy"];
  for (const type of ["research.document.updated", "research.tree.updated"]) {
    const ownerTree = ownerEvents.of(type)[0]?.payload["tree"] as Record<string, unknown>;
    const memberTree = memberEvents.of(type)[0]?.payload["tree"] as Record<string, unknown>;
    t.is(ownerTree["role"], "owner", `${type}: the actor's own view`);
    t.truthy(memberTree, type);
    for (const field of PER_PERSON) t.false(field in memberTree, `${type}: ${field}`);
  }
  t.is(
    memberEvents.of("research.document.updated")[0]?.payload["markdownChanged"],
    true,
    "the rest of the payload is the same",
  );
  // The branch asked about the passage moved with it, and everyone hears so.
  const moved = memberEvents
    .of("research.node.updated")
    .map((event) => event.payload["node"] as { id: string; anchor?: { anchor: { start: number } } })
    .find((node) => node.id === branch.id);
  t.is(moved?.anchor?.anchor.start, 18);
  ownerEvents.close();
  memberEvents.close();
});

test("a member's Delete stops their questions and drops their queued follow-ups", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const { running } = await commenterQueue(thread);
  const owner = listen(harness, thread.owner);
  await harness.caller(thread.commenter).research.removeTree({ treeId: thread.treeId });
  await settle();
  t.true(harness.runs.cancelled.includes(running.id));
  const ownerCaller = harness.caller(thread.owner);
  t.deepEqual(await ownerCaller.followups.list({ treeId: thread.treeId }), {});
  const queueChanges = owner.of("research.queue.changed");
  t.deepEqual(queueChanges.at(-1)?.payload["items"], []);
  t.true(owner.types().includes("research.sharing.changed"));
  const stopped = (await ownerCaller.research.getTree({ treeId: thread.treeId })).nodes.find(
    (node) => node.id === running.id,
  );
  t.is(stopped?.type === "exchange" ? stopped.run.status : null, "cancelled");
  owner.close();
});

test("a member's Empty Trash leaves the way Delete does", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const { running } = await commenterQueue(thread);
  const caller = harness.caller(thread.commenter);
  const workspace = await caller.workspaces.ensureDefault();
  await caller.research.trashTree({ treeId: thread.treeId });
  const commenter = listen(harness, thread.commenter);
  const emptied = await caller.research.emptyTrash({ workspaceId: workspace.id });
  await settle();
  t.deepEqual(emptied.treeIds, [thread.treeId]);
  t.true(harness.runs.cancelled.includes(running.id));
  t.deepEqual(await harness.caller(thread.owner).followups.list({ treeId: thread.treeId }), {});
  t.is(commenter.of("research.tree.removed").length, 1, "told once that the thread is gone");
  commenter.close();
});

test("removing a member sends the follow-ups their refused item held up", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const { running, item } = await commenterQueue(thread);
  const ownerCaller = harness.caller(thread.owner);
  const behind = await ownerCaller.followups.ask({
    headNodeId: thread.rootId,
    prompt: "The owner's follow-up",
  });
  t.is(behind.kind, "queued");
  followups.markFailed(harness.db, item.id, "refused");
  complete(harness, thread.commenter.id, running.id);
  await ownerCaller.sharing.removeMember({ treeId: thread.treeId, userId: thread.commenter.id });
  // The commenter's item went with them; the owner's was sent.
  t.deepEqual(await ownerCaller.followups.list({ treeId: thread.treeId }), {});
  const detail = await ownerCaller.research.getTree({ treeId: thread.treeId });
  const sent = detail.nodes.find(
    (node) => node.type === "exchange" && node.message.text === "The owner's follow-up",
  );
  t.truthy(sent);
  t.true(harness.runs.started.includes(sent?.id ?? ""));
});

test("a member made a viewer loses their queue, and dispatch refuses a viewer's item", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const { running } = await commenterQueue(thread);
  const owner = listen(harness, thread.owner);
  const ownerCaller = harness.caller(thread.owner);
  await ownerCaller.sharing.setRole({
    treeId: thread.treeId,
    userId: thread.commenter.id,
    role: "viewer",
  });
  await settle();
  t.deepEqual(await ownerCaller.followups.list({ treeId: thread.treeId }), {});
  t.deepEqual(owner.of("research.queue.changed").at(-1)?.payload["items"], []);
  owner.close();
  // An item of theirs that is still there (written past the role change) is
  // refused when its turn comes, not sent on their account.
  harness.db
    .insert(schema.followupQueue)
    .values({
      id: "viewer-item",
      treeId: thread.treeId,
      headNodeId: thread.rootId,
      authorId: thread.commenter.id,
      messageJson: { text: "Left behind" },
      model: "gemini-flash",
      effort: null,
      position: 0,
      createdAt: 1,
      failedReason: null,
    })
    .run();
  complete(harness, thread.commenter.id, running.id);
  const started = harness.runs.started.length;
  dispatchTree(
    { config: harness.deps.config, db: harness.db, eventBus: harness.eventBus, runs: harness.runs },
    thread.treeId,
  );
  t.is(harness.runs.started.length, started);
  const queues = await ownerCaller.followups.list({ treeId: thread.treeId });
  t.is(queues[thread.rootId]?.[0]?.failedReason, AUTHOR_MAY_NOT_ASK);
});

test("a private thread's feed removal reaches its owner only", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = listen(harness, thread.owner);
  const stranger = listen(harness, thread.stranger);
  await harness.caller(thread.owner).research.archiveTree({ treeId: thread.treeId });
  await harness.caller(thread.owner).research.restoreTree({ treeId: thread.treeId });
  await harness.caller(thread.owner).research.removeTree({ treeId: thread.treeId });
  await settle();
  t.true(owner.types().includes("feed.item.removed"));
  t.false(stranger.types().includes("feed.item.removed"));
  owner.close();
  stranger.close();
});

test("a public thread's feed removal reaches every signed-in reader", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  await harness.caller(thread.owner).sharing.setVisibility({
    treeId: thread.treeId,
    visibility: "public",
  });
  const stranger = listen(harness, thread.stranger);
  await harness.caller(thread.owner).research.trashTree({ treeId: thread.treeId });
  await settle();
  t.true(stranger.types().includes("feed.item.removed"));
  stranger.close();
});
