// Image attachments on the launch and save paths: the helpers every
// procedure that accepts image ids calls (`createTree`, `createPost`,
// `drafts.save`, and the follow-up procedures).
//
// The order is: resolve the ids before the message is written (the owner
// check, the count and size limits), refuse a model that cannot read images,
// then write the message, draft or queued follow-up. The repository that
// writes it records the references (`image_refs`) in the same transaction,
// which marks the images attached, and drops them when what held them is
// removed, which releases them (`images.setRefs`, `images.dropRefs` in
// `@session/db`).

import type { SessionDatabase } from "@session/db";
import { images } from "@session/db";
import type { ResearchImageAttachment, ResearchMessageAttachment } from "@session/shared";
import { findModel } from "@session/shared";
import { TRPCError } from "@trpc/server";

import { repo } from "../trpc/errors.js";

/**
 * The attachments for the image ids a request names, in order, duplicates
 * dropped. Every image must belong to `userId`; a missing or foreign id is
 * refused with the desktop's "no longer available" message (`BAD_REQUEST`),
 * as are more than 8 images or more than 20 MB of them.
 */
export function resolveImageAttachments(
  db: SessionDatabase,
  userId: string,
  ids: readonly string[] | null | undefined,
): ResearchImageAttachment[] {
  if (!ids || ids.length === 0) {
    return [];
  }
  return repo(() => images.resolveAttachments(db, userId, ids));
}

/** Refuses images for a model that cannot read them, instead of sending the
 * text without them (`ensure_adapter_reads_images`). */
export function assertModelReadsImages(
  modelId: string,
  attachments: readonly ResearchMessageAttachment[],
): void {
  if (!attachments.some((attachment) => attachment.kind === "image")) {
    return;
  }
  const model = findModel(modelId);
  if (model?.supportsImages !== true) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${model?.label ?? modelId} can't read images.`,
    });
  }
}
