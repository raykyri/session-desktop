// Follow defaults and the notification inbox through the procedures
// (`03-api-and-events.md` §2 `notifications`, `subscriptions`).

import test from "ava";

import { listen, settle, sharedThread } from "./threadHelpers.js";

test("a notification is stored in its recipient's inbox; reading it tells their tabs", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = listen(harness, thread.owner);
  const ownerCaller = harness.caller(thread.owner);
  await harness.caller(thread.commenter).research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "A branch from the owner's answer",
  });
  await settle();
  const sent = owner.of("notification.requested")[0]?.payload;
  t.is(sent?.["kind"], "branch");

  t.deepEqual(await ownerCaller.notifications.unreadCount(), { count: 1 });
  const page = await ownerCaller.notifications.list();
  t.is(page.nextCursor, null);
  t.is(page.items.length, 1);
  const stored = page.items[0];
  t.is(stored?.id, sent?.["id"] as string | undefined);
  t.is(stored?.kind, "branch");
  t.is(stored?.treeId, thread.treeId);
  t.is(stored?.href, sent?.["href"] as string);
  t.is(stored?.readAt, null);

  // Someone else cannot mark it read.
  t.deepEqual(
    await harness.caller(thread.stranger).notifications.markRead({ id: stored?.id ?? "" }),
    { changed: false },
  );
  owner.clear();
  t.deepEqual(await ownerCaller.notifications.markRead({ id: stored?.id ?? "" }), {
    changed: true,
  });
  await settle();
  t.is(owner.of("notifications.read").length, 1);
  t.deepEqual(await ownerCaller.notifications.unreadCount(), { count: 0 });
  t.not((await ownerCaller.notifications.list()).items[0]?.readAt ?? null, null);

  // Mark all read with nothing unread changes nothing and says nothing.
  owner.clear();
  t.deepEqual(await ownerCaller.notifications.markAllRead(), { count: 0 });
  await settle();
  t.is(owner.of("notifications.read").length, 0);
  owner.close();
});

test("an invitation is stored for its account and Mark all read clears the count", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const ownerCaller = harness.caller(thread.owner);
  const workspace = await ownerCaller.workspaces.ensureDefault();
  for (const body of ["First note", "Second note"]) {
    const detail = await ownerCaller.research.createPost({
      body,
      workspaceId: workspace.id,
      model: "gemini-flash",
    });
    await ownerCaller.invites.create({
      treeId: detail.tree.id,
      role: "viewer",
      githubLogin: thread.stranger.login,
    });
  }
  const strangerCaller = harness.caller(thread.stranger);
  t.deepEqual(await strangerCaller.notifications.unreadCount(), { count: 2 });
  const first = await strangerCaller.notifications.list({ limit: 1 });
  t.is(first.items[0]?.kind, "invite");
  t.is(first.items[0]?.title, `${thread.owner.login} shared a thread with you`);
  t.is(first.items[0]?.body, "Second note");
  t.not(first.nextCursor, null);
  const second = await strangerCaller.notifications.list({ limit: 1, cursor: first.nextCursor });
  t.is(second.items[0]?.body, "First note");
  t.is(second.nextCursor, null);
  t.deepEqual(await strangerCaller.notifications.markAllRead(), { count: 2 });
  t.deepEqual(await strangerCaller.notifications.unreadCount(), { count: 0 });
});

test("the owner and members follow by default; an unfollow is not undone by activity", async (t) => {
  const thread = await sharedThread(t);
  const { harness } = thread;
  const owner = listen(harness, thread.owner);
  const viewer = listen(harness, thread.viewer);
  const ownerTree = await harness.caller(thread.owner).research.getTree({ treeId: thread.treeId });
  t.true(ownerTree.tree.followed ?? false);
  const viewerTree = await harness
    .caller(thread.viewer)
    .research.getTree({ treeId: thread.treeId });
  t.true(viewerTree.tree.followed ?? false, "joining through an invitation follows");

  // The commenter's note under the root: the owner hears of it as the
  // parent's author, the viewer as a follower.
  await harness.caller(thread.commenter).research.forkNode({
    parentNodeId: thread.rootId,
    prompt: "First question from the commenter",
  });
  await settle();
  t.is(viewer.of("notification.requested")[0]?.payload["kind"], "followUp");

  const unfollowed = await harness
    .caller(thread.viewer)
    .subscriptions.set({ treeId: thread.treeId, value: false });
  t.false(unfollowed.followed ?? true);
  viewer.clear();
  owner.clear();
  // A follow-up in the root's conversation (inline, so no branch
  // notification): the owner is told as a follower; the viewer, who
  // unfollowed, is not.
  await harness.caller(thread.commenter).followups.ask({
    headNodeId: thread.rootId,
    prompt: "Second question from the commenter",
  });
  await settle();
  t.is(owner.of("notification.requested")[0]?.payload["kind"], "followUp");
  t.is(viewer.of("notification.requested").length, 0);
  t.false(
    (await harness.caller(thread.viewer).research.getTree({ treeId: thread.treeId })).tree
      .followed ?? true,
  );
  owner.close();
  viewer.close();
});
