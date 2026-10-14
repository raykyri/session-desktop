// Collaboration rules from review round 3: who is told what about a stopped
// chain, a member's Unarchive of an owner-archived thread, invitations to
// members and repeated invitations, accepting into one's own Archive or
// Trash, who a public reader sees, and the Highlights feed of shared
// threads.

import test from "ava";

import {
  access,
  followups,
  highlights,
  nodes,
  sharing,
  snapshots,
  trash,
  trees,
} from "../src/index.js";

import { addUser, anchorFor, answerTurn, sharedThreadFixture } from "./helpers.js";

const AGENT = { model: "gemini-flash" };

test("a chain stopped by someone else's answer: each reader is told what they can do", (t) => {
  const shared = sharedThreadFixture(t, ["commenter", "commenter"]);
  const { db } = shared.fixture;
  const [asker, other] = shared.members;
  if (!asker || !other) return t.fail();
  const sent = followups.ask(db, asker.userId, {
    headNodeId: shared.rootId,
    message: { text: "And a cuckoo filter?" },
    agent: AGENT,
  });
  if (sent.kind !== "sent") return t.fail();
  nodes.setStatus(db, asker.userId, sent.node.id, "failed", { error: "boom" });

  const refusal = (userId: string) => {
    const error = t.throws(() =>
      followups.ask(db, userId, {
        headNodeId: shared.rootId,
        message: { text: "Then what?" },
        agent: AGENT,
      }),
    );
    return error?.message;
  };
  t.is(refusal(asker.userId), followups.STALLED_TAIL_MESSAGES.failed);
  t.is(
    refusal(other.userId),
    `The last answer stopped. Only ${asker.login} can retry it; the owner can delete it. Branch from the answer before it to continue.`,
  );
  t.is(
    refusal(shared.fixture.userId),
    `The last answer stopped. Only ${asker.login} can retry it. Delete it, or branch from the answer before it to continue.`,
  );
});

test("a member's Unarchive of a thread its owner archived is refused, and marked", (t) => {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  // The member's own Archive: theirs to undo.
  t.is(trees.archive(db, member.userId, shared.treeId).archivedBy, "me");
  t.is(trees.sharedSummaries(db, member.userId, "archive")[0]?.archivedBy, "me");
  t.is(trees.restore(db, member.userId, shared.treeId).archivedBy, undefined);

  t.is(trees.archive(db, shared.fixture.userId, shared.treeId).archivedBy, "me");
  t.is(trees.get(db, member.userId, shared.treeId)?.archivedBy, "owner");
  t.is(trees.sharedSummaries(db, member.userId, "archive")[0]?.archivedBy, "owner");
  t.throws(() => trees.restore(db, member.userId, shared.treeId), {
    message: trees.OWNER_ARCHIVED_MESSAGE,
  });
  trees.restore(db, shared.fixture.userId, shared.treeId);
  t.is(trees.get(db, member.userId, shared.treeId)?.archivedBy, undefined);
});

test("inviting a member by login is refused", (t) => {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  t.throws(
    () =>
      sharing.createInvite(db, shared.fixture.userId, {
        treeId: shared.treeId,
        role: "commenter",
        githubLogin: member.login.toUpperCase(),
      }),
    { message: `@${member.login} already has access to this thread.` },
  );
});

test("inviting the same login again renews its one pending invitation", (t) => {
  const shared = sharedThreadFixture(t, []);
  const { db } = shared.fixture;
  const invitee = addUser(db, "invitee");
  const first = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "viewer",
    githubLogin: "invitee",
  });
  const second = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "commenter",
    githubLogin: "@Invitee",
  });
  t.false(first.renewed);
  t.true(second.renewed);
  t.is(second.invite.id, first.invite.id);
  t.is(second.invite.role, "commenter");
  const pending = sharing.listInvites(db, shared.fixture.userId, shared.treeId);
  t.is(pending.filter((invite) => invite.githubLogin !== null).length, 1);
  // The earlier link stopped working; the new one admits with the new role.
  t.throws(
    () =>
      sharing.acceptInvite(db, { id: invitee.userId, login: "invitee" }, { token: first.token }),
    { message: sharing.INVITE_MESSAGES.notFound },
  );
  t.is(
    sharing.acceptInvite(db, { id: invitee.userId, login: "invitee" }, { token: second.token })
      .role,
    "commenter",
  );
});

test("login invitations are capped per inviter per day", (t) => {
  const shared = sharedThreadFixture(t, []);
  const { db } = shared.fixture;
  for (let index = 0; index < sharing.MAX_LOGIN_INVITES_PER_DAY; index += 1) {
    sharing.createInvite(db, shared.fixture.userId, {
      treeId: shared.treeId,
      role: "viewer",
      githubLogin: `person${index}`,
    });
    // Revoked, so the thread's own pending cap does not stop the loop first.
    const listed = sharing.listInvites(db, shared.fixture.userId, shared.treeId);
    for (const invite of listed) sharing.revokeInvite(db, shared.fixture.userId, invite.id);
  }
  t.throws(
    () =>
      sharing.createInvite(db, shared.fixture.userId, {
        treeId: shared.treeId,
        role: "viewer",
        githubLogin: "one-more",
      }),
    { message: sharing.INVITE_MESSAGES.tooManyLoginInvites },
  );
  // A link invitation is not a login invitation.
  t.notThrows(() =>
    sharing.createInvite(db, shared.fixture.userId, { treeId: shared.treeId, role: "viewer" }),
  );
});

test("accepting an invitation takes the thread out of the member's Archive and Trash", (t) => {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  trees.archive(db, member.userId, shared.treeId);
  trash.trashTree(db, member.userId, shared.treeId);
  const link = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "commenter",
  });
  const accepted = sharing.acceptInvite(
    db,
    { id: member.userId, login: member.login },
    { token: link.token },
  );
  t.deepEqual(accepted, {
    treeId: shared.treeId,
    role: "commenter",
    joined: false,
    restored: true,
  });
  const row = access.memberRow(db, member.userId, shared.treeId);
  t.is(row?.archivedAt, null);
  t.is(row?.trashedAt, null);
  t.deepEqual(
    trees.sharedSummaries(db, member.userId).map((summary) => summary.id),
    [shared.treeId],
  );
});

test("a reader of a public thread sees the owner and the members who wrote something", (t) => {
  const shared = sharedThreadFixture(t, ["commenter", "viewer"]);
  const { db } = shared.fixture;
  const [writer, silent] = shared.members;
  if (!writer || !silent) return t.fail();
  const reader = addUser(db, "public-reader");
  nodes.admitChild(db, writer.userId, {
    parentNodeId: shared.rootId,
    message: { text: "A question" },
  });
  sharing.setVisibility(db, shared.fixture.userId, shared.treeId, "public");
  const ids = (userId: string | null) =>
    sharing.listMembers(db, userId, shared.treeId).map((member) => member.userId);
  t.deepEqual(ids(reader.userId), [shared.fixture.userId, writer.userId]);
  t.deepEqual(ids(null), [shared.fixture.userId, writer.userId]);
  t.deepEqual(ids(silent.userId), [shared.fixture.userId, writer.userId, silent.userId]);
  t.deepEqual(ids(shared.fixture.userId), [shared.fixture.userId, writer.userId, silent.userId]);
});

test("the Highlights feed lists shared threads, with author and role", (t) => {
  const shared = sharedThreadFixture(t, ["commenter"]);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  const mine = highlights.create(
    db,
    member.userId,
    shared.rootId,
    anchorFor(shared.revision, "bloom filter", 2),
  );
  const owners = highlights.create(
    db,
    shared.fixture.userId,
    shared.rootId,
    anchorFor(shared.revision, "probabilistic", 17),
  );
  // A public thread the member only reads is not listed.
  const stranger = addUser(db, "public-owner");
  const publicTree = trees.admitRoot(db, stranger.userId, {
    type: "exchange",
    workspaceId: stranger.workspaceId,
    message: { text: "Public question" },
    agent: AGENT,
  });
  const publicRoot = publicTree.tree.rootNodeId;
  const committed = snapshots.commit(db, stranger.userId, {
    nodeId: publicRoot,
    turns: [answerTurn(publicRoot, "A public answer.")],
    outcome: { status: "complete" },
  });
  nodes.setStatus(db, stranger.userId, publicRoot, "complete");
  highlights.create(db, stranger.userId, publicRoot, anchorFor(committed.revision, "public", 2));
  sharing.setVisibility(db, stranger.userId, publicTree.tree.id, "public");

  const feed = (userId: string, workspaceId?: string) =>
    highlights
      .feed(db, userId, workspaceId)
      .map((item) => [item.highlightId, item.authorId, item.role]);
  t.deepEqual(feed(member.userId, member.workspaceId), [
    [owners.id, shared.fixture.userId, "commenter"],
    [mine.id, member.userId, "commenter"],
  ]);
  t.deepEqual(feed(shared.fixture.userId, shared.fixture.workspaceId), [
    [owners.id, shared.fixture.userId, "owner"],
    [mine.id, member.userId, "owner"],
  ]);

  // The member's own Archive and Trash leave it out, for them alone.
  trees.archive(db, member.userId, shared.treeId);
  t.deepEqual(feed(member.userId), []);
  trees.restore(db, member.userId, shared.treeId);
  trash.trashTree(db, member.userId, shared.treeId);
  t.deepEqual(feed(member.userId), []);
  t.is(feed(shared.fixture.userId).length, 2);
  trash.restoreTree(db, member.userId, shared.treeId);
  // The owner's Trash leaves it out for the member too.
  trash.trashTree(db, shared.fixture.userId, shared.treeId);
  t.deepEqual(feed(member.userId), []);
});
