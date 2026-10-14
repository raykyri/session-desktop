// Event envelope and the research events carried in it. The desktop backend
// emits `SessionEvent` (src-tauri/src/events.rs); `parseResearchEvent` in
// `lib/researchEvents.ts` narrows a raw envelope into `ParsedResearchEvent`.

import type { ResearchHighlight, ResearchNode, ResearchTree } from "./research.js";

export interface SessionEvent {
  type: string;
  /** Desktop only: the terminal pane and agent record an event concerns. */
  paneId?: string | null;
  agentId?: string | null;
  payload: Record<string, unknown>;
  /** Milliseconds since the Unix epoch. */
  timestamp: number;
}

export interface ResearchTreeCreatedEvent {
  type: "research.tree.created";
  tree: ResearchTree;
  node: ResearchNode;
  timestamp: number;
}

export interface ResearchDocumentUpdatedEvent {
  type: "research.document.updated";
  tree: ResearchTree;
  node: ResearchNode;
  responseRevision: string;
  markdownChanged: boolean;
  removedHighlightCount: number;
  timestamp: number;
}

export interface ResearchNodeEvent {
  type: "research.node.created" | "research.node.updated";
  node: ResearchNode;
  /** Web only: 1-based place in the admission queue while the node is
   * `queued`, so a waiting reader's position advances without a refetch.
   * Absent once the run is claimed. */
  queuePosition?: number;
  timestamp: number;
}

export interface ResearchTreeEvent {
  type: "research.tree.updated" | "research.tree.archived" | "research.tree.restored";
  tree: ResearchTree;
  timestamp: number;
}

export interface ResearchHighlightCreatedEvent {
  type: "research.highlight.created";
  nodeId: string;
  highlight: ResearchHighlight;
  timestamp: number;
}

export interface ResearchHighlightsRemovedEvent {
  type: "research.highlights.removed";
  nodeId: string;
  highlightIds: string[];
  timestamp: number;
}

/** Background summary generation started or settled for a run. Purely a
 * viewer hint: the recap itself arrives as a node update. */
export interface ResearchRecapPendingEvent {
  type: "research.recap.pending";
  nodeId: string;
  pending: boolean;
  timestamp: number;
}

export interface ResearchTreeRemovedEvent {
  type: "research.tree.removed";
  treeId: string;
  timestamp: number;
}

export interface ResearchNodeRemovedEvent {
  type: "research.node.removed";
  treeId: string;
  parentNodeId: string;
  removedNodeIds: string[];
  timestamp: number;
}

/** A workspace's research drafts were created, edited, removed, or reordered. */
export interface ResearchDraftsChangedEvent {
  type: "research.drafts.changed";
  workspaceId: string;
  timestamp: number;
}

/** The stored folder state changed (from any window, or a workspace removal). */
export interface ResearchFoldersChangedEvent {
  type: "research.folders.changed";
  timestamp: number;
}

/** A tree entered or left the Trash, or a trashed tree was deleted. */
export interface ResearchTrashChangedEvent {
  type: "research.trash.changed";
  timestamp: number;
}

/** Every research event the desktop backend emits. Keeping this a closed
 * union makes a new backend event take the explicit recovery path until its
 * frontend state effects are intentionally implemented. */
export type ParsedResearchEvent =
  | ResearchTreeCreatedEvent
  | ResearchDocumentUpdatedEvent
  | ResearchNodeEvent
  | ResearchTreeEvent
  | ResearchHighlightCreatedEvent
  | ResearchHighlightsRemovedEvent
  | ResearchRecapPendingEvent
  | ResearchTreeRemovedEvent
  | ResearchNodeRemovedEvent
  | ResearchDraftsChangedEvent
  | ResearchFoldersChangedEvent
  | ResearchTrashChangedEvent;
