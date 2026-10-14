// Rows to wire values. A node row becomes the desktop's `ResearchNode`
// envelope: the fields every node shares, then the body its `type` selects
// (`@session/shared/wire`, `ResearchNodeView` in the desktop's research.rs).

import type {
  NodeAnchor,
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeBase,
  ResearchRecap,
  ResearchTree,
  UserMessage,
} from "@session/shared";
import {
  DEFAULT_MODEL_ID,
  agentSpecFor,
  nodeAnchorSchema,
  researchHighlightAnchorSchema,
  researchRecapSchema,
  userMessageSchema,
} from "@session/shared";

import {
  parseJsonColumn,
  parseNullableWireColumn,
  parseWireColumn,
  stringListSchema,
} from "../json.js";
import type { highlights, nodes, trees } from "../schema/index.js";

export type HighlightRow = typeof highlights.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;
export type TreeRow = typeof trees.$inferSelect;

export function toResearchHighlight(row: HighlightRow): ResearchHighlight {
  return {
    id: row.id,
    anchor: parseWireColumn<ResearchHighlightAnchor>(
      researchHighlightAnchorSchema,
      row.anchorJson,
      "highlights.anchor_json",
    ),
    createdAt: row.createdAt,
  };
}

/**
 * A tree as one person sees it. `lastViewedAt` is that person's row in
 * `tree_views`; it is null for a reader who has never opened the thread.
 */
export function toResearchTree(row: TreeRow, lastViewedAt: number | null = null): ResearchTree {
  return {
    id: row.id,
    title: row.title,
    rootNodeId: row.rootNodeId,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    trashedAt: row.trashedAt,
    lastViewedAt,
  };
}

/** Everything a node row needs from its neighbours to become a wire node. */
export interface NodeRelations {
  /** From the node's tree; sent as the envelope's `groupId`. */
  workspaceId: string;
  highlights: ResearchHighlight[];
}

function nodeMessage(row: NodeRow): UserMessage | null {
  return parseNullableWireColumn<UserMessage>(
    userMessageSchema,
    row.messageJson,
    "nodes.message_json",
  );
}

function requiredMessage(row: NodeRow): UserMessage {
  const message = nodeMessage(row);
  if (message === null) {
    throw new Error(`Failed to parse nodes.message_json: ${row.type} node ${row.id} has none`);
  }
  return message;
}

function nodeRecap(row: NodeRow): ResearchRecap | null {
  return parseNullableWireColumn<ResearchRecap>(
    researchRecapSchema,
    row.recapJson,
    "nodes.recap_json",
  );
}

/** The node's AgentSpec: an exchange's agent, a post's or document's
 * follow-up default. */
function rowAgent(row: NodeRow) {
  return agentSpecFor(row.model ?? DEFAULT_MODEL_ID, row.effort);
}

export function toResearchNode(row: NodeRow, relations: NodeRelations): ResearchNode {
  const anchor = parseNullableWireColumn<NodeAnchor>(
    nodeAnchorSchema,
    row.anchorJson,
    "nodes.anchor_json",
  );
  const chainOrder =
    row.chainOrderJson === null
      ? null
      : parseJsonColumn(stringListSchema, row.chainOrderJson, "nodes.chain_order_json");
  const base: ResearchNodeBase = {
    id: row.id,
    treeId: row.treeId,
    parentNodeId: row.parentNodeId,
    inline: row.inline,
    anchor,
    title: row.title,
    groupId: relations.workspaceId,
    createdAt: row.createdAt,
    highlights: relations.highlights,
    ...(chainOrder === null ? {} : { chainOrder }),
  };
  switch (row.type) {
    case "post":
      return {
        ...base,
        type: "post",
        message: requiredMessage(row),
        format: row.format ?? "text",
        followUpAgent: rowAgent(row),
        editedAt: row.editedAt,
      };
    case "exchange": {
      const status = row.status ?? "failed";
      const recap = nodeRecap(row);
      return {
        ...base,
        type: "exchange",
        message: requiredMessage(row),
        agent: rowAgent(row),
        run: {
          status,
          error: row.error,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          responseSnapshotAt: row.responseSnapshotAt,
          // Every follow-up on the web starts a fresh run with its parent's
          // stored conversation as context, which exists once the run
          // completes.
          sessionReady: status === "complete",
          attempt: row.attempt,
          responsePreview: row.responsePreview,
          ...(status === "interrupted" ? { resumePending: row.resumePending } : {}),
        },
        ...(recap === null ? {} : { recap }),
      };
    }
    case "document": {
      const recap = nodeRecap(row);
      return {
        ...base,
        type: "document",
        message: nodeMessage(row),
        source: row.source ?? "authored",
        ...(row.model === null ? {} : { followUpAgent: rowAgent(row) }),
        responseSnapshotAt: row.responseSnapshotAt,
        ...(recap === null ? {} : { recap }),
        editedAt: row.editedAt,
      };
    }
  }
}

/** The text a node's row shows: its message, or "" for a document without
 * one. */
export function rowPrompt(row: Pick<NodeRow, "messageJson">): string {
  if (row.messageJson === null) {
    return "";
  }
  return parseWireColumn<UserMessage>(userMessageSchema, row.messageJson, "nodes.message_json")
    .text;
}
