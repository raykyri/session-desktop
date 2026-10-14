// Root research documents: imported reports and documents the user authored
// as markdown rather than asked for (`docs/02-domain-model-and-database.md`
// §5.6). A document node has no run; its body is a one-turn snapshot.

import type {
  NodeAnchor,
  ResearchTreeDetail,
  Turn,
  UpdateResearchDocumentResult,
} from "@session/shared";
import { nodeAnchorSchema, sanitizeResearchTitle } from "@session/shared";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
} from "@session/shared/lib/researchDocuments";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { withFullSync } from "../connection.js";
import { parseWireColumn } from "../json.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import { requireNodeAccess } from "./access.js";
import { removeAllForNode, listForNode } from "./highlights.js";
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

/**
 * Replaces a root document's markdown under a four-way optimistic check: the
 * node is its thread's root and a document, the thread is not archived, the
 * title the editor opened with is still the title, and the revision it opened
 * with is still the answer. When the markdown changed, the highlight set must
 * also be the one the editor knew, because a rewrite deletes every highlight
 * and the user should not lose one they did not know existed.
 *
 * A title-only edit keeps the snapshot and the highlights: nothing the anchors
 * point into moved.
 */
export function update(
  db: SessionDatabase,
  userId: string,
  input: UpdateDocumentInput,
): UpdateResearchDocumentResult {
  const markdown = input.markdown.trim();
  validateDocumentMarkdown(markdown);
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
    const markdownChanged = currentMarkdown !== markdown;
    if (markdownChanged) {
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
    const at = now();
    if (markdownChanged) {
      removedHighlightCount = removeAllForNode(tx, userId, node.id);
      responseRevision = applyReplacedTurns(tx, userId, node.id, [
        documentTurn(node.id, markdown),
      ]).revision;
      tx.update(nodes).set({ editedAt: at, editedBy: userId }).where(eq(nodes.id, node.id)).run();
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
      unmatchedBranchCount: markdownChanged ? unmatchedBranches(tx, node.id, markdown) : 0,
    };
  });
}

/** Branches asked about a passage whose quote is no longer in `markdown`.
 * They keep their anchors; the count tells the editor to say so. */
function unmatchedBranches(db: SessionDatabase, nodeId: string, markdown: string): number {
  return db
    .select({ anchorJson: nodes.anchorJson })
    .from(nodes)
    .where(and(eq(nodes.parentNodeId, nodeId), isNotNull(nodes.anchorJson)))
    .all()
    .filter((row) => {
      const anchor = parseWireColumn<NodeAnchor>(
        nodeAnchorSchema,
        row.anchorJson,
        "nodes.anchor_json",
      );
      return !markdown.includes(anchor.anchor.exact);
    }).length;
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
