// Saved research drafts (`research_drafts`): unsent questions in the Drafts
// place, per person and per workspace (the desktop's `list_research_drafts`,
// `save_research_draft`, `delete_research_draft`, `reorder_research_drafts`,
// `state.rs`). Not to be confused with `repos/drafts.ts`, the interface
// drafts.
//
// A draft is private to the person who saved it: every query is scoped by
// `user_id`, and a workspace id names one of that person's workspaces.

import type {
  ResearchDraft,
  ResearchImageAttachment,
  ResearchMessageAttachment,
} from "@session/shared";
import { researchMessageAttachmentSchema } from "@session/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { parseWireColumn } from "../json.js";
import { researchDrafts } from "../schema/drafts.js";
import { workspaces } from "../schema/workspaces.js";
import { now } from "../time.js";

import { MAX_DRAFT_VALUE_BYTES } from "./drafts.js";
import { imageIdsOf, markAttached, release } from "./images.js";

const attachmentListSchema = z.array(researchMessageAttachmentSchema);

type DraftRow = typeof researchDrafts.$inferSelect;

function toResearchDraft(row: DraftRow): ResearchDraft {
  const attachments = parseWireColumn<ResearchMessageAttachment[]>(
    attachmentListSchema,
    row.attachmentsJson,
    "research_drafts.attachments_json",
  );
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    prompt: row.prompt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function workspacePredicate(userId: string, workspaceId: string) {
  return and(eq(researchDrafts.userId, userId), eq(researchDrafts.workspaceId, workspaceId));
}

/** The workspace's drafts, top of the list first. */
export function list(db: SessionDatabase, userId: string, workspaceId: string): ResearchDraft[] {
  return db
    .select()
    .from(researchDrafts)
    .where(workspacePredicate(userId, workspaceId))
    .orderBy(asc(researchDrafts.position), asc(researchDrafts.id))
    .all()
    .map(toResearchDraft);
}

export interface SaveDraftInput {
  /** Absent: a new draft at the top of the list. */
  id?: string | null | undefined;
  workspaceId: string;
  prompt: string;
  /** Replaces the draft's images; absent keeps them. Resolved by the caller
   * (`images.resolveAttachments`). */
  images?: readonly ResearchImageAttachment[] | null | undefined;
}

/**
 * Creates a draft at the top of its workspace's list when `id` is absent;
 * otherwise replaces that draft's prompt in place
 * (`save_research_draft_with_images`). `images` replaces the draft's images
 * and absent keeps them. A draft cannot change workspace: an id from another
 * workspace is not found.
 */
export function save(db: SessionDatabase, userId: string, input: SaveDraftInput): ResearchDraft {
  const prompt = input.prompt.trim();
  if (prompt === "") {
    throw new Error("Research draft prompt cannot be empty.");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_DRAFT_VALUE_BYTES) {
    throw new Error(
      `Research draft prompt exceeds maximum allowed size of ${MAX_DRAFT_VALUE_BYTES} bytes.`,
    );
  }
  const images = input.images ?? null;
  if (images?.some((attachment) => (attachment.kind as string) !== "image")) {
    throw new Error("A research draft can attach only images.");
  }
  return transact(db, (tx) => {
    const workspace = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.id, input.workspaceId)))
      .get();
    if (!workspace) {
      throw new Error(`research workspace ${input.workspaceId} was not found`);
    }
    const at = now();
    let row: DraftRow | undefined;
    let replaced: string[] = [];
    if (input.id !== undefined && input.id !== null) {
      const previous = tx
        .select()
        .from(researchDrafts)
        .where(and(workspacePredicate(userId, input.workspaceId), eq(researchDrafts.id, input.id)))
        .get();
      if (previous && images !== null) {
        replaced = imageIdsOf(toResearchDraft(previous).attachments);
      }
      row = tx
        .update(researchDrafts)
        .set({
          prompt,
          updatedAt: at,
          ...(images === null ? {} : { attachmentsJson: [...images] }),
        })
        .where(and(workspacePredicate(userId, input.workspaceId), eq(researchDrafts.id, input.id)))
        .returning()
        .get();
      if (!row) {
        throw new Error(`research draft ${input.id} was not found`);
      }
    } else {
      tx.update(researchDrafts)
        .set({ position: sql`${researchDrafts.position} + 1` })
        .where(workspacePredicate(userId, input.workspaceId))
        .run();
      row = tx
        .insert(researchDrafts)
        .values({
          id: newId(),
          userId,
          workspaceId: input.workspaceId,
          prompt,
          attachmentsJson: images === null ? [] : [...images],
          position: 0,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
    }
    markAttached(tx, imageIdsOf(images), at);
    release(tx, replaced);
    return toResearchDraft(row);
  });
}

/** Deletes one draft and returns the workspace it was in. Its images that
 * nothing else names go back to pending (`images.release`). */
export function remove(
  db: SessionDatabase,
  userId: string,
  draftId: string,
): { workspaceId: string } {
  return transact(db, (tx) => {
    const row = tx
      .delete(researchDrafts)
      .where(and(eq(researchDrafts.userId, userId), eq(researchDrafts.id, draftId)))
      .returning()
      .get();
    if (!row) {
      throw new Error(`research draft ${draftId} was not found`);
    }
    release(tx, imageIdsOf(toResearchDraft(row).attachments));
    return { workspaceId: row.workspaceId };
  });
}

/** The desktop's refusal of a reorder built from a stale list. */
export const DRAFT_ORDER_STALE = "Research draft order is stale. Refresh before reordering.";

/**
 * Reorders one workspace's drafts (`reorder_research_drafts`). `draftIds`
 * must name exactly that workspace's drafts, each once; other workspaces keep
 * their order. Returns the list and whether it changed, so the caller emits
 * only for a change.
 */
export function reorder(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  draftIds: readonly string[],
): { drafts: ResearchDraft[]; changed: boolean } {
  return transact(db, (tx) => {
    const current = list(tx, userId, workspaceId).map((draft) => draft.id);
    const requested = new Set(draftIds);
    if (
      draftIds.length !== current.length ||
      requested.size !== draftIds.length ||
      current.some((id) => !requested.has(id))
    ) {
      throw new Error(DRAFT_ORDER_STALE);
    }
    const changed = draftIds.some((id, index) => current[index] !== id);
    if (changed) {
      draftIds.forEach((id, position) => {
        tx.update(researchDrafts)
          .set({ position })
          .where(and(workspacePredicate(userId, workspaceId), eq(researchDrafts.id, id)))
          .run();
      });
    }
    return { drafts: list(tx, userId, workspaceId), changed };
  });
}
