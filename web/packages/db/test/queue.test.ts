import test from "ava";

import { queue, trees } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function admit(
  fixture: ReturnType<typeof createFixture>,
  userId: string,
  workspaceId: string,
  nodeId: string,
) {
  trees.admitRoot(fixture.db, userId, {
    workspaceId,
    prompt: nodeId,
    model: "gemini-flash",
    nodeId,
  });
  return nodeId;
}

test("claims round-robin across users rather than draining one queue", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "second");
  let at = 1_000;
  for (const nodeId of ["a1", "a2", "a3"]) {
    admit(fixture, fixture.userId, fixture.workspaceId, nodeId);
    queue.enqueue(fixture.db, fixture.userId, { nodeId, provider: "vertex", enqueuedAt: at++ });
  }
  admit(fixture, other.userId, other.workspaceId, "b1");
  queue.enqueue(fixture.db, other.userId, { nodeId: "b1", provider: "vertex", enqueuedAt: at++ });

  const claimed = queue.claim(fixture.db, { limit: 2, perUser: 2, providerDefault: 8 });
  t.deepEqual(
    claimed.map((run) => run.nodeId),
    ["a1", "b1"],
    "the second user is served before the first user's second question",
  );
});

test("the per-user cap holds and releasing frees a slot", (t) => {
  const fixture = createFixture(t);
  let at = 1_000;
  for (const nodeId of ["a1", "a2", "a3"]) {
    admit(fixture, fixture.userId, fixture.workspaceId, nodeId);
    queue.enqueue(fixture.db, fixture.userId, { nodeId, provider: "vertex", enqueuedAt: at++ });
  }
  t.is(queue.claim(fixture.db, { perUser: 2 }).length, 2);
  t.is(queue.claim(fixture.db, { perUser: 2 }).length, 0, "both slots are in flight");
  queue.release(fixture.db, "a1");
  t.deepEqual(
    queue.claim(fixture.db, { perUser: 2 }).map((run) => run.nodeId),
    ["a3"],
  );
});

test("a provider at its cap does not block a node on another provider", (t) => {
  const fixture = createFixture(t);
  let at = 1_000;
  admit(fixture, fixture.userId, fixture.workspaceId, "anthropic-1");
  queue.enqueue(fixture.db, fixture.userId, {
    nodeId: "anthropic-1",
    provider: "anthropic",
    enqueuedAt: at++,
  });
  admit(fixture, fixture.userId, fixture.workspaceId, "anthropic-2");
  queue.enqueue(fixture.db, fixture.userId, {
    nodeId: "anthropic-2",
    provider: "anthropic",
    enqueuedAt: at++,
  });
  admit(fixture, fixture.userId, fixture.workspaceId, "vertex-1");
  queue.enqueue(fixture.db, fixture.userId, {
    nodeId: "vertex-1",
    provider: "vertex",
    enqueuedAt: at++,
  });
  const claimed = queue.claim(fixture.db, {
    perUser: 5,
    perProvider: { anthropic: 1, vertex: 8 },
  });
  t.deepEqual(
    claimed.map((run) => run.nodeId),
    ["anthropic-1", "vertex-1"],
  );
});

test("a backoff hides a row until its time comes", (t) => {
  const fixture = createFixture(t);
  admit(fixture, fixture.userId, fixture.workspaceId, "a1");
  queue.enqueue(fixture.db, fixture.userId, { nodeId: "a1", provider: "vertex", enqueuedAt: 1 });
  const [claimed] = queue.claim(fixture.db, { at: 1_000 });
  t.is(claimed?.nodeId, "a1");
  queue.requeueWithBackoff(fixture.db, "a1", 20_000);
  t.deepEqual(queue.claim(fixture.db, { at: 10_000 }), []);
  t.is(queue.claim(fixture.db, { at: 20_000 }).length, 1);
});

test("positions are one-based while waiting and zero once claimed", (t) => {
  const fixture = createFixture(t);
  let at = 1_000;
  for (const nodeId of ["a1", "a2", "a3"]) {
    admit(fixture, fixture.userId, fixture.workspaceId, nodeId);
    queue.enqueue(fixture.db, fixture.userId, { nodeId, provider: "vertex", enqueuedAt: at++ });
  }
  t.is(queue.position(fixture.db, fixture.userId, "a1"), 1);
  t.is(queue.position(fixture.db, fixture.userId, "a3"), 3);
  queue.claim(fixture.db, { limit: 1, perUser: 1 });
  t.is(queue.position(fixture.db, fixture.userId, "a1"), 0);
  t.is(queue.position(fixture.db, fixture.userId, "a2"), 1);
  t.deepEqual([...queue.positions(fixture.db, fixture.userId).entries()].sort(), [
    ["a2", 1],
    ["a3", 2],
  ]);
});

test("the metadata pool is claimed independently of research", (t) => {
  const fixture = createFixture(t);
  admit(fixture, fixture.userId, fixture.workspaceId, "research-1");
  admit(fixture, fixture.userId, fixture.workspaceId, "metadata-1");
  queue.enqueue(fixture.db, fixture.userId, { nodeId: "research-1", provider: "vertex" });
  queue.enqueue(fixture.db, fixture.userId, {
    nodeId: "metadata-1",
    provider: "vertex",
    pool: "metadata",
  });
  t.deepEqual(
    queue.claim(fixture.db, { pool: "metadata", perUser: 4 }).map((run) => run.nodeId),
    ["metadata-1"],
  );
  t.deepEqual(
    queue.claim(fixture.db, { pool: "research", perUser: 4 }).map((run) => run.nodeId),
    ["research-1"],
  );
});

test("a node from another account cannot be enqueued", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "queue-other");
  admit(fixture, other.userId, other.workspaceId, "theirs");
  t.throws(
    () => queue.enqueue(fixture.db, fixture.userId, { nodeId: "theirs", provider: "vertex" }),
    {
      message: /was not found/,
    },
  );
});

test("a backed-off row is not counted as ahead of the ones still waiting", (t) => {
  const fixture = createFixture(t);
  let at = 1_000;
  for (const nodeId of ["a1", "a2", "a3"]) {
    admit(fixture, fixture.userId, fixture.workspaceId, nodeId);
    queue.enqueue(fixture.db, fixture.userId, { nodeId, provider: "vertex", enqueuedAt: at++ });
  }
  t.is(queue.position(fixture.db, fixture.userId, "a3", 5_000), 3);
  // `a1` hits a 429 and waits; it is invisible to `claim`, so it must not
  // inflate what the others are told.
  queue.requeueWithBackoff(fixture.db, "a1", 20_000);
  t.is(queue.position(fixture.db, fixture.userId, "a3", 5_000), 2);
  t.is(
    queue.position(fixture.db, fixture.userId, "a3", 20_000),
    3,
    "once its time comes it counts",
  );
  t.deepEqual([...queue.positions(fixture.db, fixture.userId, 5_000).entries()].sort(), [
    ["a1", 1],
    ["a2", 1],
    ["a3", 2],
  ]);
});
