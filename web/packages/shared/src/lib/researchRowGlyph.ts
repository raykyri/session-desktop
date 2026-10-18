// The glyph a row in the feed or a thread's messages column starts with: one
// 14px shape for the row's kind, with an exchange's run state as its interior.
// Exchanges are rings (queued dashed; running a half pie; answered a check;
// answered and unread a centre dot; failed "!"; stopped "×"). Notes, saved
// links and X posts are rounded squares, documents are pages, and drafts are
// dashed squares, each with its own inner mark. ResearchRowGlyph draws them.

import type {
  DocumentSource,
  PostFormat,
  ResearchMessageAttachment,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchTreeSummary,
} from "../wire/index.js";

import { nodeType } from "./researchNodeTypes.js";

export type ResearchRowKind =
  "exchange" | "note" | "link" | "xpost" | "imported" | "authored" | "transcript" | "draft";

/** A row's run state: an exchange's own run, or for a feed card the whole
 * thread's (a running follow-up makes the card running). */
export type ResearchRowState = "queued" | "running" | "answered" | "failed" | "stopped";

/** The drawn shape: an exchange's state, or the kind of any other row. */
export type ResearchRowGlyphShape =
  | "queued"
  | "running"
  | "answered"
  | "unread"
  | "failed"
  | "stopped"
  | Exclude<ResearchRowKind, "exchange">;

/** The glyph's colour other than the default faint text colour. */
type ResearchRowGlyphTone = "running" | "failed" | "unread";

interface ResearchRowGlyphSpec {
  shape: ResearchRowGlyphShape;
  tone: ResearchRowGlyphTone | null;
  /** The state's accessible name, or null for a state with nothing to
   * announce (answered and read, and every state of a row with no run). */
  label: string | null;
}

/** A node or a feed entry: the fields that determine its kind. */
interface KindSource {
  type?: ResearchNodeType | undefined;
  source?: DocumentSource | null;
  format?: PostFormat | null;
  attachments?: ResearchMessageAttachment[];
}

/** A row's kind from its node type, a document's source and a post's format.
 * A link post whose tweet resolved shows as its tweet: an X post. */
export function researchRowKind(entry: KindSource): ResearchRowKind {
  switch (nodeType(entry)) {
    case "post":
      if (entry.format !== "link") return "note";
      return (entry.attachments ?? []).some(
        (attachment) =>
          attachment.kind === "tweet" && attachment.status === "resolved" && attachment.tweet,
      )
        ? "xpost"
        : "link";
    case "document":
      if (entry.source === "imported") return "imported";
      if (entry.source === "transcript") return "transcript";
      return "authored";
    default:
      return "exchange";
  }
}

export function researchRowState(status: ResearchNodeStatus): ResearchRowState {
  switch (status) {
    case "queued":
      return "queued";
    // `interrupted` is the web's status for a run the server resumes after a
    // restart.
    case "starting":
    case "running":
    case "interrupted":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "answered";
  }
}

const STATE_LABELS: Record<ResearchRowState, string | null> = {
  queued: "Queued",
  running: "Running",
  answered: null,
  failed: "Failed",
  stopped: "Stopped",
};

/** The shape, colour and accessible name for a row. An exchange's state is
 * its shape; any other kind keeps its shape and takes the state's colour
 * (a note whose follow-up is running shows a running square). Unread applies
 * to an answered row only: a failure already marks the row as changed. */
export function researchRowGlyph({
  kind,
  state = "answered",
  unread = false,
}: {
  kind: ResearchRowKind;
  state?: ResearchRowState;
  unread?: boolean;
}): ResearchRowGlyphSpec {
  const showUnread = unread && state === "answered";
  const tone: ResearchRowGlyphTone | null =
    state === "running" ? "running" : state === "failed" ? "failed" : showUnread ? "unread" : null;
  const label = showUnread ? "Updated" : STATE_LABELS[state];
  if (kind !== "exchange") return { shape: kind, tone, label };
  return { shape: showUnread ? "unread" : state, tone, label };
}

/** A feed card uses the root entry's kind when loaded, otherwise the tree's
 * root type. Posts display as notes and documents as authored documents until
 * the entry loads. */
export function researchThreadKind(
  tree: Pick<ResearchTreeSummary, "rootNodeId" | "type"> | undefined,
  query: (KindSource & { nodeId: string }) | undefined,
): ResearchRowKind {
  if (query && (!tree || query.nodeId === tree.rootNodeId)) return researchRowKind(query);
  return researchRowKind({ type: tree?.type ?? query?.type });
}

/** A feed card's state: running while any run in the thread is (a queued
 * root shows as queued); else failed when a failure is unseen or the root
 * failed; else the root's own state. */
export function researchThreadState(
  tree: Pick<ResearchTreeSummary, "runningCount" | "hasUnseenFailure"> | undefined,
  query: { status: ResearchNodeStatus } | undefined,
): ResearchRowState {
  const root = query ? researchRowState(query.status) : "answered";
  if (root === "queued" || root === "running") return root;
  if ((tree?.runningCount ?? 0) > 0) return "running";
  if (tree?.hasUnseenFailure || root === "failed") return "failed";
  return root;
}

/** Whether a row of a thread's messages column shows a glyph: every row
 * except an answered exchange, the common case. */
export function researchMessageRowHasGlyph(
  kind: ResearchRowKind,
  state: ResearchRowState,
): boolean {
  return kind !== "exchange" || state !== "answered";
}
