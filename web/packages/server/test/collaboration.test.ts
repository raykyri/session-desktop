// Shared threads through the procedures: invitations, who receives which
// events, presence, notifications, who pays, stale edits, and images
// (`03-api-and-events.md` §2–§3, `02-domain-model-and-database.md` §5.16).

import { schema, snapshots } from "@session/db";
import type { ResearchImageAttachment, SessionEvent, User } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";
import sharp from "sharp";

import { sessionEvent } from "../src/events/bus.js";
import { notifyRunFinished } from "../src/research/notifications.js";

import type { Harness } from "./helpers.js";
import { anchorFor, answerTurn, createHarness } from "./helpers.js";

/** Every event a connection receives, collected as they arrive. */
function listen(harness: Harness, user: User, connectionId = `${user.login}-conn`) {
  const subscription = harness.eventBus.subscribe(user.id, connectionId);
  const events: SessionEvent[] = [];
  void (async () => {
    for await (const event of subscription.events) events.push(event);
  })();
  return {
    connectionId,
    events,
    types: () => events.map((event) => event.type),
    of: (type: string) => events.filter((event) => event.type === type),
    clear: () => {
      events.length = 0;
    },
    close: () => subscription.close(),
  };
}

/** Lets queued deliveries reach the collectors. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

interface Thread {
  harness: Harness;
  owner: User;
  commenter: User;
  viewer: User;
  stranger: User;
  treeId: string;
  rootId: string;
  revision: string;
}

/** A complete answer shared with a commenter (by link) and a viewer (by
 * login), through the procedures. */
async function sharedThread(
  t: Parameters<typeof createHarness>[0],
  env: Record<string, string> = {},
): Promise<Thread> {
  const harness = createHarness(t, { env });
  const owner = harness.addUser("thread-owner");
  const commenter = harness.addUser("thread-commenter");
  const viewer = harness.addUser("thread-viewer");
  const stranger = harness.addUser("thread-stranger");
  const ownerCaller = harness.caller(owner);
  const workspace = await ownerCaller.workspaces.ensureDefault();
  const detail = await ownerCaller.research.createTree({
    prompt: "What is a bloom filter?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const rootId = detail.tree.rootNodeId;
  const committed = snapshots.commit(harness.db, owner.id, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "A bloom filter is a probabilistic set membership structure.")],
    outcome: { status: "complete" },
  });
  harness.db.update(schema.nodes).set({ status: "complete" }).run();
  const link = await ownerCaller.invites.create({ treeId: detail.tree.id, role: "commenter" });
  t.true(link.url.endsWith(`/invite/${encodeURIComponent(link.token)}`));
  await harness.caller(commenter).invites.accept({ token: link.token });
  const byLogin = await ownerCaller.invites.create({
    treeId: detail.tree.id,
    role: "viewer",
    githubLogin: viewer.login,
  });
  const received = await harness.caller(viewer).invites.received();
  t.deepEqual(
    received.map((invite) => invite.id),
    [byLogin.invite.id],
  );
  await harness.caller(viewer).invites.accept({ inviteId: byLogin.invite.id });
  return {
    harness,
    owner,
    commenter,
    viewer,
    stranger,
    treeId: detail.tree.id,
    rootId,
    revision: committed.revision,
  };
}

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
