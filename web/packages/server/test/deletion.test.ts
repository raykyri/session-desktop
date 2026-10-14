// Deleting threads in the background (`research/deletion.ts`): Delete now,
// Empty Trash and removing a workspace hide the threads at once and answer
// as before; the job deletes their rows between requests and picks up what
// an earlier process left.

import { deletion, newId, tableRowCount, trees } from "@session/db";
import type { SessionEvent } from "@session/shared";
import test from "ava";

import { createDeletionJob } from "../src/research/deletion.js";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";

function recordEvents(harness: Harness): SessionEvent[] {
  const seen: SessionEvent[] = [];
  const emit = harness.eventBus.emit.bind(harness.eventBus);
  harness.eventBus.emit = (userId, event) => {
    seen.push(event);
    emit(userId, event);
  };
  return seen;
}

async function setup(t: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(t);
  const user = harness.addUser("deleter");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const report = async (text: string, workspaceId = workspace.id) =>
    (
      await caller.research.importReport({
        markdown: `# ${text}\n\nBody.`,
        prompt: text,
        workspaceId,
      })
    ).tree;
  return { harness, user, caller, workspace, report };
}

const nodeCount = (harness: Harness) => tableRowCount(harness.db, "nodes");

test("Delete now answers and publishes as before; the rows go in the background", async (t) => {
  const { harness, user, caller, report } = await setup(t);
  const kept = await report("Kept");
  const tree = await report("Deleted");
  const events = recordEvents(harness);

  const result = await caller.research.removeTree({ treeId: tree.id });
  t.deepEqual(result, { ok: true, treeIds: [tree.id] });
  t.deepEqual(
    events.filter((event) => event.type === "research.tree.removed").map((event) => event.payload),
    [{ treeId: tree.id, removedBy: user.id }],
  );
  // Hidden at once, whatever the job has done so far.
  await t.throwsAsync(caller.research.getTree({ treeId: tree.id }), { message: /not found/ });
  const listed = await caller.research.listTrees({ workspaceId: kept.workspaceId });
  t.deepEqual(
    listed.map((summary) => summary.id),
    [kept.id],
  );

  await harness.deps.deletions.idle();
  t.false(deletion.pending(harness.db));
  t.is(nodeCount(harness), 1, "only the kept thread's node is left");
});

test("Empty Trash and removing a workspace leave the deletion to the job", async (t) => {
  const { harness, caller, workspace, report } = await setup(t);
  const binned = await report("Binned");
  await caller.research.trashTree({ treeId: binned.id });
  const emptied = await caller.research.emptyTrash({ workspaceId: workspace.id });
  t.deepEqual(emptied.treeIds, [binned.id]);
  await t.throwsAsync(caller.research.getTree({ treeId: binned.id }));

  const other = await caller.workspaces.create({ name: "Other" });
  const inOther = await report("In the other workspace", other.id);
  await caller.workspaces.remove({ workspaceId: other.id });
  t.false((await caller.workspaces.list()).some((listed) => listed.id === other.id));
  await t.throwsAsync(caller.research.getTree({ treeId: inOther.id }));

  await harness.deps.deletions.idle();
  t.is(nodeCount(harness), 0);
  t.is(tableRowCount(harness.db, "trees"), 0);
  t.deepEqual(
    (await caller.workspaces.list()).map((listed) => listed.id),
    [workspace.id],
  );
});

test("the job yields between steps, so other work runs while it deletes", async (t) => {
  const { harness, user, report } = await setup(t);
  const tree = await report("Large");
  const root = harness.db.$client
    .prepare("SELECT root_node_id AS id FROM trees WHERE id = ?")
    .get(tree.id) as { id: string };
  const insert = harness.db.$client.prepare(
    `INSERT INTO nodes (id, tree_id, parent_node_id, author_id, inline, type, message_json, format, model, attempt, run_seq, resume_pending, created_at)
     VALUES (?, ?, ?, ?, 0, 'post', '{"text":"A note"}', 'text', 'gemini-flash', 1, 0, 0, ?)`,
  );
  for (let index = 0; index < 10; index += 1) {
    insert.run(newId(), tree.id, root.id, user.id, index);
  }
  // Bypass the procedure so this job, with one-node steps, is the only one.
  trees.remove(harness.db, user.id, tree.id);
  const job = createDeletionJob({ db: harness.db }, { limits: { rows: 1, nodes: 1 } });
  t.teardown(() => job.stop());
  const before = nodeCount(harness);
  const observed: number[] = [];
  job.kick();
  // A callback queued now runs between two steps, not after the last one.
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      observed.push(nodeCount(harness));
      resolve();
    });
  });
  await job.idle();
  t.is(before, 11);
  t.is(observed.length, 1);
  t.false(deletion.pending(harness.db));
  t.is(nodeCount(harness), 0);
  const seen = observed[0] ?? -1;
  t.true(seen > 0 && seen < before, `ran with ${seen} of ${before} nodes left`);
});

test("a new job finishes what an earlier process marked", async (t) => {
  const { harness, user, report } = await setup(t);
  const first = await report("First");
  const second = await report("Second");
  // Marked, as a process that stopped before its job ran would leave them.
  trees.remove(harness.db, user.id, first.id);
  trees.remove(harness.db, user.id, second.id);
  t.true(deletion.pending(harness.db));

  const job = createDeletionJob({ db: harness.db });
  t.teardown(() => job.stop());
  job.kick();
  job.kick();
  await job.idle();
  t.false(deletion.pending(harness.db));
  t.is(nodeCount(harness), 0);
});

test("a step that throws is retried after a pause, not in a loop", async (t) => {
  const { harness, user, report } = await setup(t);
  const tree = await report("Stuck once");
  trees.remove(harness.db, user.id, tree.id);
  let calls = 0;
  let retried: () => void = () => undefined;
  const second = new Promise<void>((resolve) => {
    retried = resolve;
  });
  const job = createDeletionJob(
    { db: harness.db },
    {
      retryMs: 20,
      step: (db, limits) => {
        calls += 1;
        if (calls === 1) throw new Error("database is locked");
        if (calls === 2) retried();
        return deletion.step(db, limits);
      },
    },
  );
  t.teardown(() => job.stop());
  const startedAt = Date.now();
  job.kick();
  await job.idle();
  t.is(calls, 1, "the job stopped after the failure");
  await second;
  t.true(Date.now() - startedAt >= 15, "and tried again after the pause");
  await job.idle();
  t.false(deletion.pending(harness.db));
});
