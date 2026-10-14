// Follow defaults and the notification inbox
// (`docs/02-domain-model-and-database.md` §5.16, §5.17).

import test from "ava";

import { notifications, schema, sharing, trees } from "../src/index.js";

import { addUser, createFixture, sharedThreadFixture } from "./helpers.js";

test("the owner follows a new thread", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Who follows this?" },
    agent: { model: "gemini-flash" },
  });
  t.true(detail.tree.followed);
  t.deepEqual(sharing.followers(fixture.db, detail.tree.id), [fixture.userId]);
});

test("a member who joins follows; an unfollow stays when they accept again", (t) => {
  const shared = sharedThreadFixture(t, ["viewer"]);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) throw new Error("no member");
  t.true(trees.get(db, member.userId, shared.treeId)?.followed ?? false);

  sharing.setFollowing(db, member.userId, shared.treeId, false);
  t.false(trees.get(db, member.userId, shared.treeId)?.followed ?? true);
  // A second invitation (here a role upgrade) leaves the choice alone.
  const upgrade = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "commenter",
  });
  const accepted = sharing.acceptInvite(
    db,
    { id: member.userId, login: member.login },
    { token: upgrade.token },
  );
  t.is(accepted.role, "commenter");
  t.false(trees.get(db, member.userId, shared.treeId)?.followed ?? true);
  t.deepEqual(sharing.followers(db, shared.treeId), [shared.fixture.userId]);
});

test("the owner's unfollow stays; a public reader follows only by choice", (t) => {
  const shared = sharedThreadFixture(t, []);
  const { db } = shared.fixture;
  sharing.setFollowing(db, shared.fixture.userId, shared.treeId, false);
  sharing.setVisibility(db, shared.fixture.userId, shared.treeId, "public");
  const reader = addUser(db, "public-reader");
  t.false(trees.get(db, reader.userId, shared.treeId)?.followed ?? true);
  t.deepEqual(sharing.followers(db, shared.treeId), []);
  sharing.setFollowing(db, reader.userId, shared.treeId, true);
  t.deepEqual(sharing.followers(db, shared.treeId), [reader.userId]);
});

function entry(
  userId: string,
  id: string,
  createdAt: number,
  treeId: string | null = null,
): notifications.NewNotification {
  return {
    id,
    userId,
    kind: "followUp",
    tone: "info",
    treeId,
    title: `Title ${id}`,
    body: `Body ${id}`,
    href: treeId === null ? null : `/r/${treeId}`,
    createdAt,
  };
}

test("the inbox lists a person's notifications newest first, a page at a time", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "someone-else");
  notifications.record(
    fixture.db,
    Array.from({ length: 5 }, (_, index) => entry(fixture.userId, `n${index}`, 1_000 + index)),
  );
  // Two in the same millisecond still page in a stable order.
  notifications.record(fixture.db, [
    entry(fixture.userId, "same-a", 2_000),
    entry(fixture.userId, "same-b", 2_000),
    entry(other.userId, "theirs", 3_000),
  ]);
  const first = notifications.list(fixture.db, fixture.userId, { limit: 3 });
  t.deepEqual(
    first.items.map((item) => item.id),
    ["same-b", "same-a", "n4"],
  );
  t.truthy(first.nextCursor);
  const second = notifications.list(fixture.db, fixture.userId, {
    limit: 3,
    cursor: first.nextCursor,
  });
  t.deepEqual(
    second.items.map((item) => item.id),
    ["n3", "n2", "n1"],
  );
  const last = notifications.list(fixture.db, fixture.userId, {
    limit: 3,
    cursor: second.nextCursor,
  });
  t.deepEqual(
    last.items.map((item) => item.id),
    ["n0"],
  );
  t.is(last.nextCursor, null);
  t.is(notifications.unreadCount(fixture.db, fixture.userId), 7);
  t.is(notifications.unreadCount(fixture.db, other.userId), 1);
});

test("marking read: one, all, and never another person's", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "reader-two");
  notifications.record(fixture.db, [
    entry(fixture.userId, "a", 1),
    entry(fixture.userId, "b", 2),
    entry(other.userId, "c", 3),
  ]);
  t.false(notifications.markRead(fixture.db, fixture.userId, "c"));
  t.true(notifications.markRead(fixture.db, fixture.userId, "a"));
  t.false(notifications.markRead(fixture.db, fixture.userId, "a"), "already read");
  t.is(notifications.unreadCount(fixture.db, fixture.userId), 1);
  const listed = notifications.list(fixture.db, fixture.userId).items;
  t.not(listed.find((item) => item.id === "a")?.readAt ?? null, null);
  t.is(listed.find((item) => item.id === "b")?.readAt, null);
  t.is(notifications.markAllRead(fixture.db, fixture.userId), 1);
  t.is(notifications.unreadCount(fixture.db, fixture.userId), 0);
  t.is(notifications.unreadCount(fixture.db, other.userId), 1);
});

test("retention: read ones after 30 days, and at most the cap per person", (t) => {
  const fixture = createFixture(t);
  const day = 24 * 60 * 60 * 1000;
  notifications.record(fixture.db, [
    entry(fixture.userId, "old-read", 1),
    entry(fixture.userId, "old-unread", 2),
  ]);
  notifications.markRead(fixture.db, fixture.userId, "old-read");
  const readAt =
    notifications.list(fixture.db, fixture.userId).items.find((item) => item.id === "old-read")
      ?.readAt ?? 0;
  t.is(notifications.prune(fixture.db, readAt + 29 * day), 0);
  t.is(notifications.prune(fixture.db, readAt + 31 * day), 1);
  t.deepEqual(
    notifications.list(fixture.db, fixture.userId).items.map((item) => item.id),
    ["old-unread"],
  );

  // `record` keeps a person within the cap; the oldest go first.
  const cap = notifications.MAX_NOTIFICATIONS_PER_USER;
  notifications.record(
    fixture.db,
    Array.from({ length: cap }, (_, index) => entry(fixture.userId, `bulk${index}`, 10 + index)),
  );
  t.is(notifications.unreadCount(fixture.db, fixture.userId), cap);
  t.false(
    fixture.db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .all()
      .some((row) => row.id === "old-unread"),
  );
  // Rows written past the cap some other way are trimmed by `prune`.
  fixture.db
    .insert(schema.notifications)
    .values({ ...entry(fixture.userId, "extra", 5), readAt: null })
    .run();
  t.is(notifications.prune(fixture.db, Date.now()), 1);
  t.is(notifications.unreadCount(fixture.db, fixture.userId), cap);
});

test("a thread's notifications go with it; one about a missing thread keeps no thread", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Delete me" },
    status: "complete",
    agent: { model: "gemini-flash" },
  });
  notifications.record(fixture.db, [
    entry(fixture.userId, "about-thread", 1, detail.tree.id),
    entry(fixture.userId, "about-nothing", 2, "no-such-tree"),
  ]);
  const missing = notifications
    .list(fixture.db, fixture.userId)
    .items.find((item) => item.id === "about-nothing");
  t.is(missing?.treeId, null);
  t.is(missing?.href, "/r/no-such-tree");
  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  t.deepEqual(
    notifications.list(fixture.db, fixture.userId).items.map((item) => item.id),
    ["about-nothing"],
  );
});
