// Answer summaries (`docs/02-domain-model-and-database.md` §5.8).
//
// Both entry points are guards around a background result. A recap is
// generated from an answer, asynchronously, and by the time it comes back the
// answer may have been retried, edited, or deleted; applying it then would
// attach a summary of something the user can no longer see.

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
      throw new Error("restore archived research before replacing its summary");
    }
    if (node.kind !== "run" || node.status !== "complete") {
      throw new Error("only completed research runs can replace a summary");
    }
    const currentRecapId = node.recapJson?.id ?? null;
    if (currentRecapId !== (input.expectedCurrentRecapId ?? null)) {
      throw new Error(
        "the summary changed while the preview was open; review the latest summary and try again",
      );
    }
    if (input.candidate.responseRevision !== input.expectedResponseRevision) {
      throw new Error("the summary candidate belongs to a different answer");
    }
    const snapshot = tx
      .select({ revision: responseSnapshots.revision })
      .from(responseSnapshots)
      .where(eq(responseSnapshots.nodeId, node.id))
      .get();
    if (!snapshot || snapshot.revision !== input.expectedResponseRevision) {
      throw new Error("the answer changed while the preview was open; generate a new summary");
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
  db.update(nodes)
    .set({ recapJson: null })
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .run();
}
