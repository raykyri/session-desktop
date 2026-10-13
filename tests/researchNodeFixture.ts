// Builds ResearchNode fixtures (the backend's ResearchNodeView) from flat
// fields, so tests can state a node the way they read: its prompt, status,
// agent and type in one object.

import type {
  DocumentSource,
  NodeAnchor,
  PostDelivery,
  PostFormat,
  ResearchHighlight,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchRecap,
  RunState,
} from "../src/types";

export interface NodeFixture {
  id?: string;
  treeId?: string;
  parentNodeId?: string | null;
  inline?: boolean;
  anchor?: NodeAnchor | null;
  title?: string | null;
  groupId?: string;
  createdAt?: number;
  highlights?: ResearchHighlight[];
  chainOrder?: string[];
  /** Defaults to "exchange". */
  type?: ResearchNodeType;
  /** Documents only; defaults to "authored". */
  source?: DocumentSource;
  prompt?: string;
  attachments?: ResearchMessageAttachment[];
  adapter?: string;
  model?: string | null;
  effort?: string | null;
  status?: ResearchNodeStatus;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  responseSnapshotAt?: number | null;
  sessionReady?: boolean;
  holdsProcess?: boolean;
  recap?: ResearchRecap | null;
  delivery?: PostDelivery | null;
  format?: PostFormat;
  editedAt?: number | null;
}

export function researchNode(fields: NodeFixture = {}): ResearchNode {
  const base = {
    id: fields.id ?? "node",
    treeId: fields.treeId ?? "tree",
    parentNodeId: fields.parentNodeId ?? null,
    inline: fields.inline ?? false,
    anchor: fields.anchor ?? null,
    title: fields.title ?? null,
    groupId: fields.groupId ?? "group",
    createdAt: fields.createdAt ?? 1,
    highlights: fields.highlights ?? [],
    ...(fields.chainOrder ? { chainOrder: fields.chainOrder } : {}),
  };
  const message = { text: fields.prompt ?? "Question", attachments: fields.attachments ?? [] };
  const agent = {
    adapter: fields.adapter ?? "claude",
    model: fields.model ?? null,
    effort: fields.effort ?? null,
  };
  switch (fields.type ?? "exchange") {
    case "post":
      return {
        ...base,
        type: "post",
        message,
        format: fields.format ?? "text",
        delivery: fields.delivery ?? null,
        followUpAgent: agent,
        editedAt: fields.editedAt ?? null,
      };
    case "document": {
      const source = fields.source ?? "authored";
      return {
        ...base,
        type: "document",
        // An imported report keeps the question it answers and a transcript
        // its first user turn; an authored document has no message.
        message: source === "authored" ? null : message,
        source,
        followUpAgent: agent,
        responseSnapshotAt: fields.responseSnapshotAt ?? null,
        recap: fields.recap ?? null,
        editedAt: fields.editedAt ?? null,
      };
    }
    default:
      return {
        ...base,
        type: "exchange",
        message,
        agent,
        run: {
          status: fields.status ?? "complete",
          error: fields.error ?? null,
          startedAt: fields.startedAt ?? null,
          completedAt: fields.completedAt ?? null,
          responseSnapshotAt: fields.responseSnapshotAt ?? null,
          sessionReady: fields.sessionReady ?? false,
          holdsProcess: fields.holdsProcess ?? false,
        },
        recap: fields.recap ?? null,
      };
  }
}

/** Returns an exchange with the run changes supplied by a later event. */
export function withRun(node: ResearchNode, patch: Partial<RunState>): ResearchNode {
  if (node.type !== "exchange") {
    throw new Error(`${node.id} has no run`);
  }
  return { ...node, run: { ...node.run, ...patch } };
}
