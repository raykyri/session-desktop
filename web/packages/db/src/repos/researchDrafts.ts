// Saved research drafts (`research_drafts`): unsent questions in the Drafts
// place, per person and per workspace (the desktop's `list_research_drafts`,
// `save_research_draft`, `delete_research_draft`, `reorder_research_drafts`).
// Not to be confused with `repos/drafts.ts`, the interface drafts.
//
// The listing is here; step 2.6 of the desktop-parity plan adds save (a new
// draft goes to the top; images are replaced only when given), remove and
// reorder.

import type { ResearchDraft, ResearchMessageAttachment } from "@session/shared";
import { researchMessageAttachmentSchema } from "@session/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { SessionDatabase } from "../connection.js";
import { parseWireColumn } from "../json.js";
import { researchDrafts } from "../schema/drafts.js";

const attachmentListSchema = z.array(researchMessageAttachmentSchema);

/** The workspace's drafts, top of the list first. */
export function list(db: SessionDatabase, userId: string, workspaceId: string): ResearchDraft[] {
  return db
    .select()
    .from(researchDrafts)
    .where(and(eq(researchDrafts.userId, userId), eq(researchDrafts.workspaceId, workspaceId)))
    .orderBy(asc(researchDrafts.position), asc(researchDrafts.id))
    .all()
    .map((row) => {
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
    });
}
