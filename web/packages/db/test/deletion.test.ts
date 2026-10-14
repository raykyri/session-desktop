// Deleting large threads: deep chains, wide levels, and the indexes the
// cascades from `nodes` rely on.

import test from "ava";

import { feeds, newId, trees } from "../src/index.js";

import { createFixture } from "./helpers.js";

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

test("a thread with a deep chain and a wide level is deleted in one pass", (t) => {
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
  t.log(`deleted 3201 nodes in ${Date.now() - startedAt} ms`);
  t.deepEqual(removed.treeIds, [detail.tree.id]);
  t.is(count(), 0);
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
