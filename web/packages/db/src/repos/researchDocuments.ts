// Root research documents: imported reports and documents the user authored
// as markdown rather than asked for (`docs/02-domain-model-and-database.md`
// §5.6). A document node has no run; its body is a one-turn snapshot.

import type {
  NodeAnchor,
  ResearchNode,
  ResearchTreeDetail,
  Turn,
  UpdateResearchDocumentResult,
} from "@session/shared";
import { nodeAnchorSchema, sanitizeResearchTitle } from "@session/shared";
import { reanchorResearchQuote } from "@session/shared/lib/researchAnchors";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
} from "@session/shared/lib/researchDocuments";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { withFullSync } from "../connection.js";
import { parseWireColumn } from "../json.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import { requireNodeAccess } from "./access.js";
import { listForNode } from "./highlights.js";
import { toResearchHighlight } from "./mappers.js";
import { get as getNode } from "./nodes.js";
import { applyReplacedTurns, read as readSnapshot } from "./snapshots.js";
import type { NodeAgentInput } from "./trees.js";
import { admitRoot, detail, treeFor } from "./trees.js";

/** The single-turn form a document's markdown is stored in, so the viewer,
 * the revision hash, and highlight anchors all see one representation. */
export function documentTurn(nodeId: string, markdown: string): Turn {
  return {
    id: `${nodeId}-document`,
    agentId: nodeId,
    role: "assistant",
    blocks: [{ type: "text", text: markdown }],
    sourceIndex: 0,
  };
}

/** The markdown of a document node's snapshot, or null when it is not a
 * single text turn. */
export function markdownFromTurns(turns: readonly Turn[]): string | null {
  const texts = turns.flatMap((turn) =>
    turn.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  );
  return texts.length === 0 ? null : texts.join("");
}

export function validateDocumentMarkdown(markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > RESEARCH_DOCUMENT_BYTE_LIMIT) {
    throw new Error(
      `Document exceeds the maximum allowed size of ${RESEARCH_DOCUMENT_BYTE_LIMIT} bytes.`,
    );
  }
  // Throws `ResearchDocumentWordLimitExceeded` past the limit, without
  // scanning the rest of the document.
  countResearchDocumentWords(markdown, RESEARCH_DOCUMENT_WORD_LIMIT);
}

export interface UpdateDocumentInput {
  nodeId: string;
  markdown: string;
  title?: string | null | undefined;
  expectedTitle: string;
  expectedResponseRevision: string;
  /** Checked only when the markdown actually changed. */
  expectedHighlightIds?: readonly string[] | undefined;
}

/** What `update` did, with the branches whose passage anchors moved, for
 * the caller's `research.node.updated` events. */
export interface UpdateDocumentOutcome extends UpdateResearchDocumentResult {
  movedBranches: ResearchNode[];
}

/**
 * Replaces a root document's markdown under a four-way optimistic check: the
 * node is its thread's root and a document, the thread is not archived, the
 * title the editor opened with is still the title, and the revision it opened
 * with is still the answer. When the markdown changed, the highlight set must
 * also be the one the editor knew, because a rewrite can delete highlights
 * and the user should not lose one they did not know existed.
 *
 * A new body moves each highlight, and each branch asked about a passage, to
 * its quote in the new text (`reanchorResearchQuote`); a highlight whose
 * quote is gone is deleted, a branch keeps its anchor. The recap is cleared
 * (`update_research_document` in `state.rs`). A title-only edit keeps the
 * snapshot and the highlights: nothing the anchors point into moved.
 */
export function update(
  db: SessionDatabase,
  userId: string,
  input: UpdateDocumentInput,
): UpdateDocumentOutcome {
  const markdown = input.markdown.trim();
  return withFullSync(db, (tx) => {
    // A document is a thread's root, and saving it renames the thread: the
    // owner's.
    const { node, tree } = requireNodeAccess(tx, userId, input.nodeId, "owner");
    if (
      node.type !== "document" ||
      node.source === "transcript" ||
      node.parentNodeId !== null ||
      tree.rootNodeId !== node.id
    ) {
      throw new Error("Cannot edit non-root node: only root research documents can be edited.");
    }
    if (tree.archivedAt !== null) {
      throw new Error(
        "Cannot edit document in archived research: restore the research thread first.",
      );
    }
    if (tree.trashedAt !== null) {
      throw new Error(
        "Cannot edit document in research in the Trash: restore the research thread first.",
      );
    }
    if (tree.title !== input.expectedTitle) {
      throw new Error(
        "Document title conflict: the title was modified concurrently. Reopen the editor and try again.",
      );
    }
    const snapshot = readSnapshot(tx, userId, node.id);
    if (!snapshot) {
      throw new Error("the document's content is unavailable");
    }
    if (snapshot.revision !== input.expectedResponseRevision) {
      throw new Error(
        "Document content conflict: the document was updated concurrently. Reopen the editor and try again.",
      );
    }
    const currentMarkdown = markdownFromTurns(snapshot.turns);
    if (currentMarkdown === null) {
      throw new Error("the document's content is unavailable");
    }
    // The stored body is trimmed for the comparison as the request is, so a
    // title-only save of a body stored with surrounding whitespace (an
    // imported report ending in a newline) does not count as a rewrite.
    const markdownChanged = currentMarkdown.trim() !== markdown;
    if (markdownChanged) {
      // Only a new body is validated: an imported report may exceed the
      // editor's word limit, and its title stays editable.
      validateDocumentMarkdown(markdown);
      const expected = new Set(input.expectedHighlightIds ?? []);
      const current = listForNode(tx, userId, node.id).map((highlight) => highlight.id);
      const same =
        current.length === expected.size && current.every((value) => expected.has(value));
      if (!same) {
        throw new Error(
          "Highlight conflict: highlights were modified concurrently while editing. Reopen the editor and try again.",
        );
      }
    }
    const title =
      (input.title == null ? undefined : sanitizeResearchTitle(input.title)) ??
      deriveResearchDocumentTitle(markdown);
    let responseRevision = snapshot.revision;
    let removedHighlightCount = 0;
    let movedBranchIds: string[] = [];
    let unmatchedBranchCount = 0;
    const at = now();
    if (markdownChanged) {
      responseRevision = applyReplacedTurns(tx, userId, node.id, [
        documentTurn(node.id, markdown),
      ]).revision;
      removedHighlightCount = reanchorHighlights(
        tx,
        node.id,
        currentMarkdown,
        markdown,
        responseRevision,
      );
      const branches = reanchorBranches(tx, node.id, currentMarkdown, markdown, responseRevision);
      movedBranchIds = branches.movedIds;
      unmatchedBranchCount = branches.unmatched;
      // A recap describes the previous body (`state.rs`
      // `update_research_document`).
      tx.update(nodes)
        .set({ editedAt: at, editedBy: userId, recapJson: null })
        .where(eq(nodes.id, node.id))
        .run();
    }
    const treeRow = tx
      .update(trees)
      // `max(now, updated_at + 1)` rather than a value read before the
      // snapshot write, which bumped `updated_at` itself.
      .set({ title, updatedAt: sql`max(${at}, ${trees.updatedAt} + 1)` })
      .where(eq(trees.id, tree.id))
      .returning()
      .get();
    const updatedNode = getNode(tx, userId, node.id);
    if (!updatedNode) {
      throw new Error(`research node ${node.id} was not found`);
    }
    return {
      tree: treeFor(tx, userId, treeRow),
      node: updatedNode,
      responseRevision,
      markdownChanged,
      removedHighlightCount,
      unmatchedBranchCount,
      movedBranches: movedBranchIds.flatMap((id) => getNode(tx, userId, id) ?? []),
    };
  });
}

/** Moves the document's highlights to their quote in the new body
 * (`reanchorResearchQuote`, the desktop's `reanchor_highlights`): a moved
 * highlight takes the new offsets and revision, one whose quote is gone is
 * deleted. Returns how many were deleted. */
function reanchorHighlights(
  db: SessionDatabase,
  nodeId: string,
  oldMarkdown: string,
  newMarkdown: string,
  revision: string,
): number {
  let removed = 0;
  for (const row of db.select().from(highlights).where(eq(highlights.nodeId, nodeId)).all()) {
    const { anchor } = toResearchHighlight(row);
    const outcome = reanchorResearchQuote(anchor, oldMarkdown, newMarkdown);
    if (outcome.kind === "unmatched") {
      db.delete(highlights).where(eq(highlights.id, row.id)).run();
      removed += 1;
    } else if (outcome.kind === "moved") {
      db.update(highlights)
        .set({
          anchorJson: {
            ...anchor,
            start: outcome.start,
            end: outcome.end,
            responseRevision: revision,
          },
        })
        .where(eq(highlights.id, row.id))
        .run();
    }
  }
  return removed;
}

/** Moves the anchors of the branches asked about a passage of the document
 * with their quote, as highlights move. A branch whose quote is gone keeps
 * its anchor, and is counted so the editor can say so. */
function reanchorBranches(
  db: SessionDatabase,
  nodeId: string,
  oldMarkdown: string,
  newMarkdown: string,
  revision: string,
): { movedIds: string[]; unmatched: number } {
  const movedIds: string[] = [];
  let unmatched = 0;
  for (const row of db
    .select({ id: nodes.id, anchorJson: nodes.anchorJson })
    .from(nodes)
    .where(and(eq(nodes.parentNodeId, nodeId), isNotNull(nodes.anchorJson)))
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .all()) {
    const stored = parseWireColumn<NodeAnchor>(
      nodeAnchorSchema,
      row.anchorJson,
      "nodes.anchor_json",
    );
    const outcome = reanchorResearchQuote(stored.anchor, oldMarkdown, newMarkdown);
    if (outcome.kind === "unmatched") {
      unmatched += 1;
    } else if (outcome.kind === "moved") {
      const anchor: NodeAnchor = {
        ...stored,
        anchor: {
          ...stored.anchor,
          start: outcome.start,
          end: outcome.end,
          responseRevision: revision,
        },
      };
      db.update(nodes).set({ anchorJson: anchor }).where(eq(nodes.id, row.id)).run();
      movedIds.push(row.id);
    }
  }
  return { movedIds, unmatched };
}

export interface ImportReportInput {
  workspaceId: string;
  /** The question the report answers. */
  prompt: string;
  /** Already stripped of citation markers and validated. */
  markdown: string;
  /** The agent its follow-ups default to. */
  agent: NodeAgentInput;
}

/**
 * Files an imported report as a new thread whose root is a document with
 * `source = imported`. The node and its body are written in one durable
 * transaction, so no reader sees a document without content.
 */
export function importReport(
  db: SessionDatabase,
  userId: string,
  input: ImportReportInput,
): ResearchTreeDetail {
  validateDocumentMarkdown(input.markdown);
  return withFullSync(db, (tx) => {
    const created = admitRoot(tx, userId, {
      workspaceId: input.workspaceId,
      type: "document",
      source: "imported",
      message: { text: input.prompt },
      agent: input.agent,
      title: deriveResearchDocumentTitle(input.markdown),
    });
    const nodeId = created.tree.rootNodeId;
    applyReplacedTurns(tx, userId, nodeId, [documentTurn(nodeId, input.markdown)]);
    return detail(tx, userId, created.tree.id);
  });
}
