// Saved passages of an answer (`docs/02-domain-model-and-database.md` §5.5).

import type {
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchHighlightFeedItem,
} from "@session/shared";
import {
  MAX_RESEARCH_HIGHLIGHTS_PER_NODE,
  MAX_RESEARCH_HIGHLIGHT_BYTES_PER_NODE,
  MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL,
  highlightStorageBytes,
  researchHighlightAnchorSchema,
  validateHighlightAnchor,
} from "@session/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { parseJsonColumn } from "../json.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { responseSnapshots } from "../schema/snapshots.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import { toResearchHighlight } from "./mappers.js";

/** Shown when an anchor was captured against an answer that has since been
 * replaced. Kept verbatim from the desktop. */
export const REVISION_MISMATCH =
  "The research response has been updated; please reselect the text.";

export function listForNode(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): ResearchHighlight[] {
  return db
    .select()
    .from(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.nodeId, nodeId)))
    .orderBy(asc(highlights.createdAt), asc(highlights.id))
    .all()
    .map(toResearchHighlight);
}

/**
 * Saves one highlight.
 *
 * The anchor is validated first, in the desktop's evaluation order, because
 * the order decides which message a doubly-invalid anchor gets. Then the
 * anchor's revision has to be the node's current one — an anchor is an offset
 * into a specific answer, and an offset into a replaced answer points at
 * whatever happens to be there. Then the three caps.
 */
export function create(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  anchor: ResearchHighlightAnchor,
  id: string = newId(),
): ResearchHighlight {
  validateHighlightAnchor(anchor);
  return transact(db, (tx) => {
    const node = tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
      .get();
    if (!node) {
      throw new Error(`research node ${nodeId} was not found`);
    }
    const snapshot = tx
      .select({ revision: responseSnapshots.revision })
      .from(responseSnapshots)
      .where(eq(responseSnapshots.nodeId, nodeId))
      .get();
    if (!snapshot || snapshot.revision !== anchor.responseRevision) {
      throw new Error(REVISION_MISMATCH);
    }
    const existing = listForNode(tx, userId, nodeId);
    if (existing.length >= MAX_RESEARCH_HIGHLIGHTS_PER_NODE) {
      throw new Error(
        `Maximum highlight limit reached: each response allows up to ${MAX_RESEARCH_HIGHLIGHTS_PER_NODE} highlights.`,
      );
    }
    const candidate: ResearchHighlight = { id, anchor, createdAt: now() };
    const added = highlightStorageBytes(candidate);
    const nodeBytes = existing.reduce(
      (total, highlight) => total + highlightStorageBytes(highlight),
      0,
    );
    if (nodeBytes + added > MAX_RESEARCH_HIGHLIGHT_BYTES_PER_NODE) {
      throw new Error("Highlight data exceeds the maximum allowed byte limit for this answer.");
    }
    if (userStorageBytes(tx, userId) + added > MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL) {
      throw new Error("Account highlight storage quota exceeded.");
    }
    if (tx.select({ id: highlights.id }).from(highlights).where(eq(highlights.id, id)).get()) {
      throw new Error("Highlight IDs must be non-empty and unique.");
    }
    tx.insert(highlights)
      .values({
        id: candidate.id,
        userId,
        nodeId,
        anchorJson: anchor,
        responseRevision: anchor.responseRevision,
        createdAt: candidate.createdAt,
      })
      .run();
    return candidate;
  });
}

/** Total highlight storage charged to one account, across every node. */
export function userStorageBytes(db: SessionDatabase, userId: string): number {
  return db
    .select()
    .from(highlights)
    .where(eq(highlights.userId, userId))
    .all()
    .reduce((total, row) => total + highlightStorageBytes(toResearchHighlight(row)), 0);
}

export function remove(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  highlightId: string,
): ResearchHighlight {
  const row = db
    .delete(highlights)
    .where(
      and(
        eq(highlights.userId, userId),
        eq(highlights.nodeId, nodeId),
        eq(highlights.id, highlightId),
      ),
    )
    .returning()
    .get();
  if (!row) {
    throw new Error(`research highlight ${highlightId} was not found`);
  }
  return toResearchHighlight(row);
}

export function removeMany(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  highlightIds: string[],
): ResearchHighlight[] {
  if (highlightIds.length === 0) {
    return [];
  }
  return db
    .delete(highlights)
    .where(
      and(
        eq(highlights.userId, userId),
        eq(highlights.nodeId, nodeId),
        inArray(highlights.id, highlightIds),
      ),
    )
    .returning()
    .all()
    .map(toResearchHighlight);
}

/** Every highlight on a node, removed at once — what a markdown rewrite does
 * to a document's highlights, since their anchors no longer address anything. */
export function removeAllForNode(db: SessionDatabase, userId: string, nodeId: string): number {
  return db
    .delete(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.nodeId, nodeId)))
    .returning({ id: highlights.id })
    .all().length;
}

/**
 * The Highlights feed: newest first, from threads that are not archived
 * (`docs/02` §5.9). `nodeLabel` is the node's title, or its prompt, or — for a
 * document, which has neither — the thread's title.
 */
export function feed(
  db: SessionDatabase,
  userId: string,
  workspaceId?: string | null,
): ResearchHighlightFeedItem[] {
  return db
    .select({
      highlightId: highlights.id,
      nodeId: nodes.id,
      treeId: trees.id,
      treeTitle: trees.title,
      nodeTitle: nodes.title,
      prompt: nodes.prompt,
      anchorJson: highlights.anchorJson,
      createdAt: highlights.createdAt,
    })
    .from(highlights)
    .innerJoin(nodes, eq(nodes.id, highlights.nodeId))
    .innerJoin(trees, eq(trees.id, nodes.treeId))
    .where(
      and(
        eq(highlights.userId, userId),
        isNull(trees.archivedAt),
        workspaceId ? eq(trees.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(desc(highlights.createdAt), desc(highlights.id))
    .all()
    .map((row) => {
      const anchor = parseJsonColumn(
        researchHighlightAnchorSchema,
        row.anchorJson,
        "highlights.anchor_json",
      );
      const label = [row.nodeTitle, row.prompt].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim() !== "",
      );
      return {
        highlightId: row.highlightId,
        nodeId: row.nodeId,
        treeId: row.treeId,
        treeTitle: row.treeTitle,
        nodeLabel: label ?? row.treeTitle,
        exact: anchor.exact,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        createdAt: row.createdAt,
      };
    });
}

/** Number of highlights associated with a node for UI limit reporting. */
export function countForNode(db: SessionDatabase, userId: string, nodeId: string): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.nodeId, nodeId)))
    .get();
  return row?.value ?? 0;
}
