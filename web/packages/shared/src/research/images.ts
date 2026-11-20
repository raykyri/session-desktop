// Image attachments: the limits of the desktop's research image store
// (`src-tauri/src/research_images.rs`) and the web routes that serve it. The
// server enforces the limits when an image is uploaded and when a message or
// draft names it; the composer can use them to reject a file before uploading
// it.

/** Largest image a message carries: the Claude API's limit per image. A
 * larger PNG or JPEG is downscaled when it is uploaded. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Largest file accepted by an upload, before downscaling. */
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

/** Most image bytes one message can carry. */
export const MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Most images one message can carry. */
export const MAX_IMAGES_PER_MESSAGE = 8;

/** Longest side an image retains without downscaling; the Claude API rejects
 * larger images. */
export const MAX_IMAGE_SIDE = 8000;

/** Longest side of a downscaled image. */
export const DOWNSCALED_IMAGE_SIDE = 2048;

/** Longest side of the JPEG thumbnail kept beside a PNG or JPEG image. GIF
 * and WebP images are their own thumbnail. */
export const IMAGE_THUMBNAIL_SIDE = 256;

/** The image types an upload accepts, recognized by their leading bytes. */
export const RESEARCH_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ResearchImageMimeType = (typeof RESEARCH_IMAGE_MIME_TYPES)[number];

/** `POST` a multipart body with one `file` field here; the response is the
 * `ResearchImageAttachment`. */
export const RESEARCH_IMAGE_UPLOAD_PATH = "/api/images";

/** Where an uploaded image, or its thumbnail, is served to its owner. */
export function researchImageUrl(id: string, options: { thumbnail?: boolean } = {}): string {
  return `/images/${encodeURIComponent(id)}${options.thumbnail === true ? "?thumb" : ""}`;
}
