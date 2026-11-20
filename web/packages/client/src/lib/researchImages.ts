// Images attached to research questions: what a composer accepts and how
// messages label them. Ported from the desktop's `src/lib/researchImages.ts`,
// whose DOM helpers keep it out of `@session/shared`; the limits are the
// server's (`@session/shared` `research/images.ts`, enforced again by
// `POST /api/images` and by every procedure that names an image).

import type { ResearchImageAttachment, ResearchMessageAttachment } from "@session/shared";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_INPUT_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_BYTES,
} from "@session/shared";

/** PNG and JPEG are downscaled by the server when they are too large; GIF
 * and WebP must fit as they are. */
const DOWNSCALED_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const RESEARCH_IMAGE_TYPE_ERROR = "Only PNG, JPEG, GIF, and WebP images can be attached.";
export const RESEARCH_IMAGE_SIZE_ERROR = "Images must be 20 MB or smaller.";
export const RESEARCH_IMAGE_UNSCALED_SIZE_ERROR = "GIF and WebP images must be 5 MB or smaller.";
export const RESEARCH_MESSAGE_IMAGE_SIZE_ERROR = "A message's images can total 20 MB at most.";
export const RESEARCH_IMAGE_COUNT_ERROR = `A message can include up to ${MAX_IMAGES_PER_MESSAGE} images.`;
export const RESEARCH_NOTE_IMAGE_ERROR =
  "Notes can't include images. Switch to Ask to send them with a question.";

/** The image attachments of a message, in order. */
export function researchImages(
  attachments: readonly ResearchMessageAttachment[] | undefined,
): ResearchImageAttachment[] {
  return (attachments ?? []).filter(
    (attachment): attachment is ResearchImageAttachment => attachment.kind === "image",
  );
}

/** The faint label a Home card shows in place of thumbnails: "[Image]" or
 * "[3 images]"; null without images. */
export function researchImageLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "[Image]" : `[${count} images]`;
}

/** Alt text for an attached image: its original file name, or "Image". */
export function researchImageAlt(image: ResearchImageAttachment): string {
  return image.fileName?.trim() || "Image";
}

/** Why a message with these images cannot go to this model, or null when it
 * can: their stored sizes total more than a message carries, or the model
 * cannot read images. The send stays blocked rather than dropping the images
 * (the desktop's `researchImageBlockReason`, keyed by registry model on the
 * web). */
export function researchImageBlockReason(
  model: { label: string; supportsImages: boolean } | null,
  images: readonly ResearchImageAttachment[] | undefined,
): string | null {
  if (!images || images.length === 0) return null;
  const total = images.reduce((sum, image) => sum + (image.byteSize || 0), 0);
  if (total > MAX_MESSAGE_IMAGE_BYTES) return RESEARCH_MESSAGE_IMAGE_SIZE_ERROR;
  if (!model || model.supportsImages) return null;
  return `${model.label} can't read images.`;
}

interface ImageFileLike {
  type: string;
  size: number;
}

/** The files a composer attaches, in order, and the error to show for the
 * rest: an unsupported type, a file over the size limit for its type, or
 * more images than a message can hold alongside the `existing` ones. */
export function acceptResearchImageFiles<T extends ImageFileLike>(
  files: readonly T[],
  existing: number,
): { accepted: T[]; error: string | null } {
  const accepted: T[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.type)) {
      error ??= RESEARCH_IMAGE_TYPE_ERROR;
    } else if (file.size > MAX_INPUT_IMAGE_BYTES) {
      error ??= RESEARCH_IMAGE_SIZE_ERROR;
    } else if (!DOWNSCALED_TYPES.has(file.type) && file.size > MAX_IMAGE_BYTES) {
      error ??= RESEARCH_IMAGE_UNSCALED_SIZE_ERROR;
    } else if (existing + accepted.length >= MAX_IMAGES_PER_MESSAGE) {
      error ??= RESEARCH_IMAGE_COUNT_ERROR;
    } else {
      accepted.push(file);
    }
  }
  return { accepted, error };
}

/** Whether copied HTML is one image and nothing else: no text outside its
 * tags and a single `<img>`. */
function htmlIsOneImage(html: string): boolean {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "");
  const images = body.match(/<img\b/gi)?.length ?? 0;
  const text = body
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
  return images === 1 && text === "";
}

/** Whether a paste that carries image files attaches them instead of
 * pasting its text. A copied image comes with HTML that is just its
 * `<img>`, its URL as text, or, from a file manager, its file names. Copied
 * cells, a word, or a document also carry a rendered image of the
 * selection, and those paste as text. */
export function pasteAttachesImages(
  text: string,
  fileNames: readonly string[],
  html = "",
): boolean {
  if (html.trim() && htmlIsOneImage(html)) return true;
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  const names = new Set(fileNames.filter(Boolean));
  if (lines.every((line) => names.has(line))) return true;
  return lines.length === 1 && /^(https?:\/\/|file:\/\/|data:image\/)\S+$/i.test(lines[0] ?? "");
}

/** The files of a paste or drop. Clipboard images appear only as items. */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .flatMap((item) => item.getAsFile() ?? []);
  return fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
}

/** Whether a drag carries files (the only drags a composer accepts). */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes("Files"));
}

/** Whether a drop of these files is for the image input rather than the
 * report import: any of them is an image. */
export function dropHasImages(files: readonly { type: string }[]): boolean {
  return files.some((file) => file.type.startsWith("image/"));
}
