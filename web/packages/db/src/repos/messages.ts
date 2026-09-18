// The canonical conversation the app owns (`docs/04-agent-runtime.md` §4).
//
// Append-only: a node's messages are written once, when the node completes,
// and never edited. Fable 5.1 invalidates thinking blocks on edited history;
// other providers do not care, but one rule is simpler than two.

import { and, asc, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import type { NodeMessage } from "../json.js";
import { nodeMessageSchema, parseJsonColumn } from "../json.js";
import { nodes } from "../schema/nodes.js";
import { nodeMessages, nodeSummaries } from "../schema/runs.js";
import { now } from "../time.js";

export interface MessageWrite {
  message: NodeMessage;
  /** Which model produced an assistant message; a cross-model fork reads this
   * to decide whether to keep provider reasoning metadata. */
  model?: string | null | undefined;
}

export interface StoredMessage {
  nodeId: string;
  position: number;
  message: NodeMessage;
  model: string | null;
  createdAt: number;
}

function requireNode(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): typeof nodes.$inferSelect {
  const row = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .get();
  if (!row) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  return row;
}

/**
 * Appends the messages of a finished attempt.
 *
 * Refused unless the node is `complete`: a node that failed, was cancelled, or
 * was interrupted will be retried or resumed, and its partial exchanges are
 * either discarded (retry) or already in `run_turns` (resume). Writing them
 * here would put a half-turn into the permanent history of the thread.
 */
export function appendMessages(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  messages: readonly MessageWrite[],
): number {
  if (messages.length === 0) {
    return 0;
  }
  return transact(db, (tx) => {
    const node = requireNode(tx, userId, nodeId);
    if (node.status !== "complete") {
      throw new Error("only a completed run's messages become part of the conversation");
    }
    const last = tx
      .select({ position: nodeMessages.position })
      .from(nodeMessages)
      .where(eq(nodeMessages.nodeId, nodeId))
      .orderBy(asc(nodeMessages.position))
      .all()
      .at(-1);
    let position = (last?.position ?? -1) + 1;
    const at = now();
    for (const entry of messages) {
      tx.insert(nodeMessages)
        .values({
          nodeId,
          position,
          messageJson: entry.message,
          model: entry.model ?? null,
          createdAt: at,
        })
        .run();
      position += 1;
    }
    return messages.length;
  });
}

export function listMessages(db: SessionDatabase, userId: string, nodeId: string): StoredMessage[] {
  requireNode(db, userId, nodeId);
  return db
    .select()
    .from(nodeMessages)
    .where(eq(nodeMessages.nodeId, nodeId))
    .orderBy(asc(nodeMessages.position))
    .all()
    .map((row) => ({
      nodeId: row.nodeId,
      position: row.position,
      message: parseJsonColumn(nodeMessageSchema, row.messageJson, "node_messages.message_json"),
      model: row.model,
      createdAt: row.createdAt,
    }));
}

/** The node ids from the tree's root down to `nodeId`, inclusive. */
export function ancestorPath(db: SessionDatabase, userId: string, nodeId: string): string[] {
  const path: string[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(`research node ${current} is its own ancestor`);
    }
    seen.add(current);
    const node: typeof nodes.$inferSelect = requireNode(db, userId, current);
    path.push(node.id);
    current = node.parentNodeId;
  }
  return path.reverse();
}

/**
 * A node's context: every message of its strict ancestors along the tree path,
 * root first. The node's own messages are not included — a node in flight has
 * none, and one that completed has an answer, not a question to continue.
 */
export function ancestorMessages(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): StoredMessage[] {
  const path = ancestorPath(db, userId, nodeId);
  return path.slice(0, -1).flatMap((ancestorId) => listMessages(db, userId, ancestorId));
}

export interface NodeSummary {
  nodeId: string;
  summary: string;
  coversThroughNodeId: string;
  createdAt: number;
}

/** Caches the compaction summary that stands in for the oldest exchanges when
 * a thread outgrows the context budget (`docs/04` §4). */
export function saveSummary(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  summary: string,
  coversThroughNodeId: string,
): NodeSummary {
  requireNode(db, userId, nodeId);
  const at = now();
  const row = db
    .insert(nodeSummaries)
    .values({ nodeId, summary, coversThroughNodeId, createdAt: at })
    .onConflictDoUpdate({
      target: nodeSummaries.nodeId,
      set: { summary, coversThroughNodeId, createdAt: at },
    })
    .returning()
    .get();
  return {
    nodeId: row.nodeId,
    summary: row.summary,
    coversThroughNodeId: row.coversThroughNodeId,
    createdAt: row.createdAt,
  };
}

export function getSummary(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): NodeSummary | null {
  requireNode(db, userId, nodeId);
  const row = db.select().from(nodeSummaries).where(eq(nodeSummaries.nodeId, nodeId)).get();
  return row
    ? {
        nodeId: row.nodeId,
        summary: row.summary,
        coversThroughNodeId: row.coversThroughNodeId,
        createdAt: row.createdAt,
      }
    : null;
}
