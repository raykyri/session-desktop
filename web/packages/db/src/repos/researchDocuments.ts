// Root research documents: imported reports and anything else the user
// authored as markdown rather than asked for
// (`docs/02-domain-model-and-database.md` §5.6).
//
// Manages root markdown research documents, distinct from attached reference documents in `repos/documents.ts`.

import type { Turn, UpdateResearchDocumentResult } from "@session/shared";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
  sanitizeResearchTitle,
} from "@session/shared";
import { and, eq, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { withFullSync } from "../connection.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import { removeAllForNode, listForNode } from "./highlights.js";
import { toResearchTree } from "./mappers.js";
import { get as getNode } from "./nodes.js";
import { applyReplacedTurns, read as readSnapshot } from "./snapshots.js";

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
    const node = tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)))
      .get();
    if (!node) {
      throw new Error(`research node ${input.nodeId} was not found`);
    }
    const tree = tx.select().from(trees).where(eq(trees.id, node.treeId)).get();
    if (!tree) {
      throw new Error(`research tree ${node.treeId} was not found`);
    }
    if (node.kind !== "document" || node.parentNodeId !== null || tree.rootNodeId !== node.id) {
      throw new Error("Cannot edit non-root node: only root research documents can be edited.");
    }
    if (tree.archivedAt !== null) {
      throw new Error(
        "Cannot edit document in archived research: restore the research thread first.",
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
      tree: toResearchTree(treeRow),
      node: updatedNode,
      responseRevision,
      markdownChanged,
      removedHighlightCount,
    };
  });
}
