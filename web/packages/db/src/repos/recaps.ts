// Answer summaries (`docs/02-domain-model-and-database.md` §5.8).
//
// Entry points validate revision consistency before applying asynchronously generated summaries to prevent applying stale summaries to updated responses.

import type { ResearchNode, ResearchRecap, ResearchRecapCandidate } from "@session/shared";
import { normalizeRecap, validateRecapInstructions } from "@session/shared";
import { and, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { nodes } from "../schema/nodes.js";
import { responseSnapshots } from "../schema/snapshots.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import { upsertResearchRoot } from "./feedgen.js";
import { get as getNode } from "./nodes.js";

export interface SaveRecapInput {
  nodeId: string;
  text: string;
  responseRevision: string;
  model: string;
  /** The `response_snapshot_at` the generation was started against. */
  expectedSnapshotAt: number | null;
  /**
   * The recap id the node carried when the generation started, or null when it
   * carried none.
   *
   * The other three guards all key on the *answer*, and applying a recap the
   * user previewed changes neither the snapshot nor the revision — so an
   * automatic recap that started before the dialog was opened would come back
   * seconds later and silently replace the summary the user just wrote,
   * instructions and all. `applyCandidate` already refuses on exactly this
   * comparison; here it is a no-op, as the rest of `save` is.
   */
  expectedCurrentRecapId?: string | null | undefined;
}

/**
 * Commits an automatically generated recap, or does nothing.
 *
 * A no-op rather than an error: nothing asked for this recap, so a stale one
 * is not a failure to report. Three of the conditions are the desktop's
 * (`state.rs:8942`) — still complete, same snapshot, same revision — and the
 * fourth is `expectedCurrentRecapId`, which is what keeps a scheduled recap
 * from overwriting one the user applied while it was generating.
 */
export function save(
  db: SessionDatabase,
  userId: string,
  input: SaveRecapInput,
): ResearchNode | null {
  const text = normalizeRecap(input.text);
  if (text === undefined) {
    return null;
  }
  return transact(db, (tx) => {
    const node = tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)))
      .get();
    if (!node || node.status !== "complete") {
      return null;
    }
    if ((node.responseSnapshotAt ?? null) !== input.expectedSnapshotAt) {
      return null;
    }
    if (
      input.expectedCurrentRecapId !== undefined &&
      (node.recapJson?.id ?? null) !== (input.expectedCurrentRecapId ?? null)
    ) {
      return null;
    }
    const snapshot = tx
      .select({ revision: responseSnapshots.revision })
      .from(responseSnapshots)
      .where(eq(responseSnapshots.nodeId, node.id))
      .get();
    if (!snapshot || snapshot.revision !== input.responseRevision) {
      return null;
    }
    const recap: ResearchRecap = {
      id: newId(),
      text,
      responseRevision: input.responseRevision,
      generatedAt: now(),
      model: input.model,
    };
    tx.update(nodes).set({ recapJson: recap }).where(eq(nodes.id, node.id)).run();
    upsertResearchRoot(tx, node.id);
    return getNode(tx, userId, node.id);
  });
}

export interface ApplyCandidateInput {
  nodeId: string;
  expectedResponseRevision: string;
  /** The recap id the preview was compared against; absent when there was
   * none. Separate from the answer revision because regenerating a recap does
   * not change the answer. */
  expectedCurrentRecapId?: string | null | undefined;
  candidate: ResearchRecapCandidate;
}

/**
 * Applies a recap the user previewed. Unlike {@link save} this reports its
 * refusals: the user is waiting on the dialog and has to be told what changed.
 */
export function applyCandidate(
  db: SessionDatabase,
  userId: string,
  input: ApplyCandidateInput,
): ResearchNode {
  return transact(db, (tx) => {
    const node = tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)))
      .get();
    if (!node) {
      throw new Error(`research node ${input.nodeId} was not found`);
    }
    const tree = tx.select().from(trees).where(eq(trees.id, node.treeId)).get();
    if (tree?.archivedAt != null) {
      throw new Error("Cannot update summary of archived research: restore the thread first.");
    }
    if (node.kind !== "run" || node.status !== "complete") {
      throw new Error("Cannot update summary: the research run has not completed.");
    }
    const currentRecapId = node.recapJson?.id ?? null;
    if (currentRecapId !== (input.expectedCurrentRecapId ?? null)) {
      throw new Error(
        "Summary conflict: the summary was modified while the preview was open. Review the updated summary and retry.",
      );
    }
    if (input.candidate.responseRevision !== input.expectedResponseRevision) {
      throw new Error(
        "Invalid summary candidate: candidate response revision does not match the current answer revision.",
      );
    }
    const snapshot = tx
      .select({ revision: responseSnapshots.revision })
      .from(responseSnapshots)
      .where(eq(responseSnapshots.nodeId, node.id))
      .get();
    if (!snapshot || snapshot.revision !== input.expectedResponseRevision) {
      throw new Error(
        "Response revision conflict: the underlying answer was updated while generating the summary. Please regenerate.",
      );
    }
    const text = normalizeRecap(input.candidate.text);
    if (text === undefined) {
      throw new Error("the summary candidate is invalid");
    }
    const instructions = validateRecapInstructions(input.candidate.instructions);
    const recap: ResearchRecap = {
      id: input.candidate.id,
      text,
      responseRevision: input.expectedResponseRevision,
      generatedAt: input.candidate.generatedAt,
      model: input.candidate.model,
      instructions,
    };
    tx.update(nodes).set({ recapJson: recap }).where(eq(nodes.id, node.id)).run();
    upsertResearchRoot(tx, node.id);
    const updated = getNode(tx, userId, node.id);
    if (!updated) {
      throw new Error(`research node ${node.id} was not found`);
    }
    return updated;
  });
}

/** Drops a node's recap. Used when a retry invalidates the answer it summed
 * up; `nodes.resetForRetry` already does this as part of its reset. */
export function clear(db: SessionDatabase, userId: string, nodeId: string): void {
  transact(db, (tx) => {
    const row = tx
      .update(nodes)
      .set({ recapJson: null })
      .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
      .returning({ id: nodes.id })
      .get();
    if (row) upsertResearchRoot(tx, row.id);
  });
}
