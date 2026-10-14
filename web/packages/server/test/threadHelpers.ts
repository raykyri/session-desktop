// Shared threads through the procedures, for the collaboration tests: an
// event collector and a thread shared with a commenter and a viewer.

import { schema, snapshots } from "@session/db";
import type { SessionEvent, User } from "@session/shared";

import type { Harness } from "./helpers.js";
import { answerTurn, createHarness } from "./helpers.js";

/** Every event a connection receives, collected as they arrive. */
export function listen(harness: Harness, user: User, connectionId = `${user.login}-conn`) {
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
export const settle = () => new Promise((resolve) => setImmediate(resolve));

export interface Thread {
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
export async function sharedThread(
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
