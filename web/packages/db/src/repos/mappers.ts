// Row shapes to wire shapes. One place, so a column added to `nodes` reaches
// `ResearchNode` (or is deliberately kept out of it) exactly once.

import type {
  ResearchHighlight,
  ResearchNode,
  ResearchTree,
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchRecap,
} from "@session/shared";
import {
  researchHighlightAnchorSchema,
  researchMessageAttachmentSchema,
  researchRecapSchema,
} from "@session/shared";
import { z } from "zod";

import { parseJsonColumn, parseNullableJsonColumn } from "../json.js";
import type { highlights, nodes, trees } from "../schema/index.js";

export type HighlightRow = typeof highlights.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;
export type TreeRow = typeof trees.$inferSelect;

const attachmentListSchema = z.array(researchMessageAttachmentSchema);

export function toResearchHighlight(row: HighlightRow): ResearchHighlight {
  return {
    id: row.id,
    anchor: parseJsonColumn(
      researchHighlightAnchorSchema,
      row.anchorJson,
      "highlights.anchor_json",
    ),
    createdAt: row.createdAt,
  };
}

export function toResearchTree(row: TreeRow): ResearchTree {
  return {
    id: row.id,
    title: row.title,
    rootNodeId: row.rootNodeId,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    lastViewedAt: row.lastViewedAt,
    followed: row.followed,
    bookmarked: row.bookmarked,
  };
}

/** Everything a node row needs from its neighbours to become a wire node. */
export interface NodeRelations {
  /** From the node's tree; `nodes` does not carry it. */
  workspaceId: string;
  highlights: ResearchHighlight[];
  documentIds: string[];
}

export function toResearchNode(row: NodeRow, relations: NodeRelations): ResearchNode {
  const queryAnchor: ResearchHighlightAnchor | null = parseNullableJsonColumn(
    researchHighlightAnchorSchema,
    row.queryAnchorJson,
    "nodes.query_anchor_json",
  );
  const attachments: ResearchMessageAttachment[] = parseJsonColumn(
    attachmentListSchema,
    row.attachmentsJson ?? [],
    "nodes.attachments_json",
  );
  const recap: ResearchRecap | null = parseNullableJsonColumn(
    researchRecapSchema,
    row.recapJson,
    "nodes.recap_json",
  );
  return {
    id: row.id,
    treeId: row.treeId,
    workspaceId: relations.workspaceId,
    parentNodeId: row.parentNodeId,
    queryAnchor,
    inline: row.inline,
    prompt: row.prompt,
    attachments,
    documentIds: relations.documentIds,
    title: row.title,
    responsePreview: row.responsePreview,
    model: row.model,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    error: row.error,
    attempt: row.attempt,
    responseSnapshotAt: row.responseSnapshotAt,
    ...(recap === null ? {} : { recap }),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    highlights: relations.highlights,
  };
}
