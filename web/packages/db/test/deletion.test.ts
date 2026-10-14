// Deleting large threads (`repos/deletion.ts`): hidden at once, then deleted
// in bounded steps that resume after a restart; deep chains, wide levels, and
// the indexes the cascades from `nodes` rely on.

import { join } from "node:path";

import test from "ava";
import { eq, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import {
  access,
  closeDatabase,
  deletion,
  feedItems,
  feeds,
  highlights,
  newId,
  nodes,
  openDatabase,
  researchDrafts,
  schema,
  sharing,
  tableRowCount,
  trash,
  trees,
  workspaces,
} from "../src/index.js";

import { addUser, anchorFor, createFixture, sharedThreadFixture } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

/** Inserts `count` notes under `parentId`, each under the one before when
 * `chain`, else all under `parentId`. Written directly, since the point is
 * the shape, not the admission rules. */
function insertNotes(
  fixture: Fixture,
  treeId: string,
  parentId: string,
  count: number,
  chain: boolean,
): string[] {
  const insert = fixture.db.$client.prepare(
    `INSERT INTO nodes (id, tree_id, parent_node_id, author_id, inline, type, message_json, format, model, attempt, run_seq, resume_pending, created_at)
     VALUES (?, ?, ?, ?, ?, 'post', ?, 'text', 'gemini-flash', 1, 0, 0, ?)`,
  );
  const ids: string[] = [];
  let parent = parentId;
  fixture.db.$client.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = newId();
      insert.run(
        id,
        treeId,
        parent,
        fixture.userId,
        chain ? 1 : 0,
        JSON.stringify({ text: `Note ${index}` }),
        index,
      );
      ids.push(id);
      if (chain) parent = id;
    }
  })();
  return ids;
}

test("a thread with a deep chain and a wide level is hidden at once and deleted in bounded steps", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "Root note" },
    agent: { model: "gemini-flash" },
  });
  const rootId = detail.tree.rootNodeId;
  const chain = insertNotes(fixture, detail.tree.id, rootId, 2_000, true);
  // More siblings than one delete statement names.
  insertNotes(fixture, detail.tree.id, chain[10] ?? rootId, 1_200, false);
  const count = () =>
    (
      fixture.db.$client
        .prepare("SELECT count(*) AS n FROM nodes WHERE tree_id = ?")
        .get(detail.tree.id) as { n: number }
    ).n;
  t.is(count(), 3_201);
  const startedAt = Date.now();
  const removed = trees.remove(fixture.db, fixture.userId, detail.tree.id);
  t.log(`marked a thread of 3201 nodes deleted in ${Date.now() - startedAt} ms`);
  t.deepEqual(removed.treeIds, [detail.tree.id]);
  t.is(trees.get(fixture.db, fixture.userId, detail.tree.id), null);
  t.is(count(), 3_201, "the rows are left to the deletion job");

  let steps = 0;
  let slowest = 0;
  for (;;) {
    const stepStartedAt = performance.now();
    const step = deletion.step(fixture.db);
    slowest = Math.max(slowest, performance.now() - stepStartedAt);
    if (step === null) break;
    steps += 1;
    t.true(step.nodes <= deletion.DEFAULT_STEP_LIMITS.nodes);
  }
  t.log(`deleted them in ${steps} steps, the slowest ${slowest.toFixed(1)} ms`);
  t.is(count(), 0);
  t.is(tableRowCount(fixture.db, "trees"), 0);
});

test("the cascades from nodes have indexes to follow", (t) => {
  const fixture = createFixture(t);
  const indexed = (table: string, column: string): boolean =>
    (fixture.db.$client.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).some(
      (index) =>
        (
          fixture.db.$client.prepare(`PRAGMA index_info("${index.name}")`).all() as {
            seqno: number;
            name: string;
          }[]
        ).some((column_) => column_.seqno === 0 && column_.name === column),
    );
  t.true(indexed("widget_revisions", "node_id"));
  t.true(indexed("highlights", "node_id"));
});

test("recent queries read the owner's threads, not every account's roots", (t) => {
  const fixture = createFixture(t);
  const plan = (
    fixture.db.$client
      .prepare(
        `EXPLAIN QUERY PLAN SELECT nodes.id FROM trees CROSS JOIN nodes
         WHERE trees.owner_id = ? AND trees.archived_at IS NULL AND trees.trashed_at IS NULL
           AND nodes.id = trees.root_node_id AND nodes.parent_node_id IS NULL AND nodes.type <> 'document'
         ORDER BY nodes.created_at DESC, nodes.id DESC LIMIT 21`,
      )
      .all(fixture.userId) as { detail: string }[]
  ).map((row) => row.detail);
  t.log(plan.join("\n"));
  t.true(plan.some((line) => /SEARCH trees USING INDEX/.test(line)));
  t.true(plan.some((line) => /SEARCH nodes USING INDEX .*\(id=\?\)/.test(line)));
  // And the query itself still answers.
  trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Listed" },
    agent: { model: "gemini-flash" },
  });
  t.deepEqual(
    feeds.recentQueries(fixture.db, fixture.userId).items.map((item) => item.prompt),
    ["Listed"],
  );
});

test("a deleted thread leaves every list and access check at once", (t) => {
  const shared = sharedThreadFixture(t);
  const { fixture, treeId, rootId, revision } = shared;
  const member = shared.members[0];
  if (!member) throw new Error("expected a member");
  sharing.setVisibility(fixture.db, fixture.userId, treeId, "public");
  highlights.create(fixture.db, fixture.userId, rootId, anchorFor(revision, "bloom filter", 2));
  sharing.setFollowing(fixture.db, member.userId, treeId, true);
  const link = sharing.createInvite(fixture.db, fixture.userId, { treeId, role: "viewer" });
  const latecomer = addUser(fixture.db, "latecomer");
  // A thread listed under it in another place, which loses its parent.
  const other = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Another question" },
    agent: { model: "gemini-flash" },
    status: "complete",
  });
  fixture.db
    .update(schema.trees)
    .set({ parentTreeId: treeId, archivedAt: 1 })
    .where(eq(schema.trees.id, other.tree.id))
    .run();
  t.truthy(trees.get(fixture.db, member.userId, treeId));

  const removed = trees.remove(fixture.db, fixture.userId, treeId);
  t.deepEqual(removed.treeIds, [treeId]);
  t.deepEqual(removed.memberIds, { [treeId]: [member.userId] });

  const listed = (summaries: { id: string }[]) => summaries.some((tree) => tree.id === treeId);
  t.false(
    listed(trees.summaries(fixture.db, fixture.userId, { workspaceId: fixture.workspaceId })),
  );
  t.false(listed(trees.publicSummaries(fixture.db, null)));
  t.false(listed(trees.sharedSummaries(fixture.db, member.userId)));
  for (const reader of [fixture.userId, member.userId, null]) {
    t.is(trees.get(fixture.db, reader, treeId), null);
    t.is(nodes.get(fixture.db, reader, rootId), null);
    t.is(access.treeAccess(fixture.db, reader, treeId), null);
  }
  t.deepEqual(highlights.feed(fixture.db, fixture.userId), []);
  t.deepEqual(highlights.feed(fixture.db, member.userId), []);
  t.deepEqual(feeds.recentQueries(fixture.db, fixture.userId).items, []);
  t.deepEqual(feedItems.stream(fixture.db, { scope: "all", limit: 10 }), []);
  t.deepEqual(sharing.followers(fixture.db, treeId), []);
  t.is(sharing.audience(fixture.db, treeId), null);
  t.throws(() =>
    sharing.acceptInvite(
      fixture.db,
      { id: latecomer.userId, login: "latecomer" },
      { token: link.token },
    ),
  );
  t.is(
    fixture.db
      .select({ parent: schema.trees.parentTreeId })
      .from(schema.trees)
      .where(eq(schema.trees.id, other.tree.id))
      .get()?.parent,
    null,
  );
  t.true(deletion.pending(fixture.db));

  deletion.drain(fixture.db);
  t.false(deletion.pending(fixture.db));
  t.is(fixture.db.select().from(schema.trees).where(eq(schema.trees.id, treeId)).get(), undefined);
  t.truthy(trees.get(fixture.db, fixture.userId, other.tree.id), "the other thread stays");
});

/** Inserts `count` run turns for `nodeId`, as a long run leaves them. */
function insertTurns(fixture: Fixture, nodeId: string, count: number): void {
  const insert = fixture.db.$client.prepare(
    `INSERT INTO run_turns (node_id, attempt, turn_id, position, turn_json, committed, seq, updated_at)
     VALUES (?, 1, ?, ?, '{}', 1, ?, 0)`,
  );
  fixture.db.$client.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(nodeId, `turn-${index}`, index, index);
    }
  })();
}

test("the job deletes a marked thread's rows in bounded steps", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "Root note" },
    agent: { model: "gemini-flash" },
  });
  const rootId = detail.tree.rootNodeId;
  const chain = insertNotes(fixture, detail.tree.id, rootId, 7, true);
  for (const nodeId of [rootId, ...chain]) insertTurns(fixture, nodeId, 4);
  // A thread nobody deletes keeps all of its rows.
  const kept = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "Kept" },
    agent: { model: "gemini-flash" },
  });
  insertTurns(fixture, kept.tree.rootNodeId, 3);

  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  const limits = { rows: 5, nodes: 3 };
  const steps: deletion.DeletionStep[] = [];
  for (
    let step = deletion.step(fixture.db, limits);
    step !== null;
    step = deletion.step(fixture.db, limits)
  ) {
    steps.push(step);
  }
  t.true(steps.length > 5, `took ${steps.length} steps`);
  for (const step of steps) {
    t.true(step.rows <= limits.rows && step.nodes <= limits.nodes);
    t.is(step.treeId, detail.tree.id);
  }
  t.true(steps.at(-1)?.finished === true);
  t.is(steps.filter((step) => step.finished).length, 1);
  t.is(
    steps.reduce((sum, step) => sum + step.nodes, 0),
    8,
  );
  t.is(
    steps.reduce((sum, step) => sum + step.rows, 0),
    32,
  );
  t.is(tableRowCount(fixture.db, "nodes"), 1);
  t.is(tableRowCount(fixture.db, "run_turns"), 3);
  t.deepEqual(fixture.db.select({ id: schema.trees.id }).from(schema.trees).all(), [
    { id: kept.tree.id },
  ]);
});

test("deletion resumes from what is left after a restart", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "Root note" },
    agent: { model: "gemini-flash" },
  });
  insertNotes(fixture, detail.tree.id, detail.tree.rootNodeId, 20, true);
  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  const limits = { rows: 100, nodes: 5 };
  deletion.step(fixture.db, limits);
  deletion.step(fixture.db, limits);
  t.is(tableRowCount(fixture.db, "nodes"), 11);

  // A new process: another connection to the same file, with nothing of the
  // first one's state.
  const reopened = openDatabase(join(fixture.directory, "session.db"));
  try {
    t.true(deletion.pending(reopened));
    t.is(trees.get(reopened, fixture.userId, detail.tree.id), null, "still hidden");
    t.true(deletion.drain(reopened, limits) >= 3);
    t.is(tableRowCount(reopened, "nodes"), 0);
    t.is(tableRowCount(reopened, "trees"), 0);
    t.false(deletion.pending(reopened));
  } finally {
    closeDatabase(reopened);
  }
});

test("a removed workspace is gone at once; its row goes after its last thread", (t) => {
  const shared = sharedThreadFixture(t);
  const { fixture } = shared;
  const member = shared.members[0];
  if (!member) throw new Error("expected a member");
  const doomed = workspaces.create(fixture.db, fixture.userId, "Doomed");
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: doomed.id,
    message: { text: "In the doomed workspace" },
    agent: { model: "gemini-flash" },
  });
  researchDrafts.save(fixture.db, fixture.userId, { workspaceId: doomed.id, prompt: "Draft" });
  fixture.db
    .insert(schema.folders)
    .values({
      id: "folder-1",
      ownerId: fixture.userId,
      workspaceId: doomed.id,
      name: "Folder",
      position: 0,
      createdAt: 1,
    })
    .run();
  // The member's Trash entry for the shared thread is filed under one of
  // their workspaces; removing it moves the entry to their default one.
  const memberSpare = workspaces.create(fixture.db, member.userId, "Spare");
  trash.trashTree(fixture.db, member.userId, shared.treeId, { workspaceId: memberSpare.id });
  // A workspace with nothing in it is deleted at once.
  const empty = workspaces.create(fixture.db, fixture.userId, "Empty");
  workspaces.remove(fixture.db, fixture.userId, empty.id);
  t.is(
    fixture.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, empty.id)).get(),
    undefined,
  );

  workspaces.remove(fixture.db, fixture.userId, doomed.id);
  workspaces.remove(fixture.db, member.userId, memberSpare.id);
  t.false(workspaces.list(fixture.db, fixture.userId).some((ws) => ws.id === doomed.id));
  t.is(workspaces.get(fixture.db, fixture.userId, doomed.id), null);
  t.throws(() => workspaces.rename(fixture.db, fixture.userId, doomed.id, "Back"));
  t.throws(() =>
    trees.admitRoot(fixture.db, fixture.userId, {
      type: "post",
      workspaceId: doomed.id,
      message: { text: "Too late" },
      agent: { model: "gemini-flash" },
    }),
  );
  t.is(tableRowCount(fixture.db, "research_drafts"), 0);
  t.is(tableRowCount(fixture.db, "folders"), 0);
  t.is(trees.get(fixture.db, fixture.userId, detail.tree.id), null);
  t.deepEqual(
    trees
      .sharedSummaries(fixture.db, member.userId, "trash", { workspaceId: member.workspaceId })
      .map((tree) => tree.id),
    [shared.treeId],
    "the member's Trash entry falls back to their default workspace",
  );
  t.truthy(
    fixture.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, doomed.id)).get(),
    "the row waits for the thread's rows",
  );

  deletion.drain(fixture.db);
  t.is(
    fixture.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, doomed.id)).get(),
    undefined,
  );
  t.truthy(trees.get(fixture.db, fixture.userId, shared.treeId), "other threads stay");
});

/** The tables with a foreign key to `table`, from SQLite itself. */
function referencing(fixture: Fixture, table: string): string[] {
  const tables = (
    fixture.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
  return tables
    .filter((name) =>
      (
        fixture.db.$client.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {
          table: string;
        }[]
      ).some((key) => key.table === table),
    )
    .sort();
}

test("marking and the steps cover every table that hangs off a thread, a node or a workspace", (t) => {
  const fixture = createFixture(t);
  const names = (tables: readonly SQLiteTable[]) => tables.map((table) => getTableName(table));
  // Deleted at mark time, deleted by the steps with the nodes, or the
  // thread's own self-reference (`parent_tree_id`, cleared at mark time).
  t.deepEqual(
    referencing(fixture, "trees"),
    [
      ...names(deletion.MARK_DELETED_TABLES),
      "image_refs",
      "nodes",
      "trees",
      "widget_revisions",
    ].sort(),
  );
  // Deleted in bounded batches before their nodes, or at most a row or two
  // per node and left to the cascade.
  t.deepEqual(
    referencing(fixture, "nodes"),
    [
      ...names(deletion.NODE_DEPENDENT_TABLES),
      "feed_items",
      "followup_queue",
      "nodes",
      "run_queue",
    ].sort(),
  );
  // Deleted when the workspace is removed, cleared then (a member's Trash
  // workspace), or the threads themselves.
  t.deepEqual(
    referencing(fixture, "workspaces"),
    [...names(deletion.WORKSPACE_DEPENDENT_TABLES), "tree_members", "trees"].sort(),
  );
});
