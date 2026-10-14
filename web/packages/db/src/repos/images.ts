// Image attachments (`research_images`): the owner check and metadata behind
// a `ResearchImageAttachment`. The bytes are on the volume, written through
// `server/src/uploads/storage.ts`.
//
// The lookup is here; step 2.9 of the desktop-parity plan adds recording an
// upload, marking images attached when a node, queued follow-up or draft
// uses them, and sweeping the ones that stay unattached.

import type { ResearchImageAttachment } from "@session/shared";
import { and, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { researchImages } from "../schema/images.js";

export type ImageRow = typeof researchImages.$inferSelect;

/** The image if `userId` owns it. */
export function get(db: SessionDatabase, userId: string, imageId: string): ImageRow | null {
  return (
    db
      .select()
      .from(researchImages)
      .where(and(eq(researchImages.ownerId, userId), eq(researchImages.id, imageId)))
      .get() ?? null
  );
}

/** The attachment a message carries for an image row. */
export function toAttachment(row: ImageRow): ResearchImageAttachment {
  return {
    kind: "image",
    id: row.id,
    mimeType: row.mime,
    byteSize: row.byteSize,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    ...(row.fileName === null ? {} : { fileName: row.fileName }),
  };
}
