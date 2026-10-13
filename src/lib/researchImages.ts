// Images attached to research questions: what a composer accepts, which
// agents can read them, and how messages label them. The backend stores the
// files (src-tauri/src/research_images.rs) and applies the same limits.
import type { ResearchImageAttachment, ResearchMessageAttachment } from "../types";

export const RESEARCH_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const RESEARCH_IMAGE_MAX_COUNT = 8;
const RESEARCH_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const RESEARCH_IMAGE_TYPE_ERROR = "Only PNG, JPEG, GIF, and WebP images can be attached.";
export const RESEARCH_IMAGE_SIZE_ERROR = "Images must be 10 MB or smaller.";
export const RESEARCH_IMAGE_COUNT_ERROR = `A message can include up to ${RESEARCH_IMAGE_MAX_COUNT} images.`;
export const RESEARCH_NOTE_IMAGE_ERROR = "Notes can't include images. Switch to Ask to send them with a question.";

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

/** Agents whose research runs send images with the prompt (Claude Code as
 * content blocks, Codex as image files). Grok's headless mode has none. */
function researchAgentReadsImages(adapterId: string): boolean {
  return adapterId === "claude" || adapterId === "codex";
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

/** Why a message with `imageCount` images cannot go to this agent, or null
 * when it can. The send stays blocked rather than dropping the images.
 * Without a label, the agent is named from its id. */
export function researchImageBlockReason(
  adapterId: string | null | undefined,
  adapterLabel: string | null | undefined,
  imageCount: number,
): string | null {
  if (imageCount === 0 || !adapterId || researchAgentReadsImages(adapterId)) return null;
  return `${adapterLabel || AGENT_NAMES[adapterId] || adapterId} can't read images.`;
}

interface ImageFileLike {
  type: string;
  size: number;
}

/** The files a composer attaches, in order, and the error to show for the
 * rest: an unsupported type, a file over the size limit, or more images
 * than a message can hold alongside the `existing` ones. */
export function acceptResearchImageFiles<T extends ImageFileLike>(
  files: readonly T[],
  existing: number,
): { accepted: T[]; error: string | null } {
  const accepted: T[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (!RESEARCH_IMAGE_TYPES.has(file.type)) {
      error ??= RESEARCH_IMAGE_TYPE_ERROR;
    } else if (file.size > RESEARCH_IMAGE_MAX_BYTES) {
      error ??= RESEARCH_IMAGE_SIZE_ERROR;
    } else if (existing + accepted.length >= RESEARCH_IMAGE_MAX_COUNT) {
      error ??= RESEARCH_IMAGE_COUNT_ERROR;
    } else {
      accepted.push(file);
    }
  }
  return { accepted, error };
}

/** Whether a paste that carries image files attaches them instead of
 * pasting its text. A copied image comes with its URL (one word) or, from
 * Finder, its file names; copied cells or a document also carry a rendered
 * image of the selection, and those paste as text. */
export function pasteAttachesImages(text: string, fileNames: readonly string[]): boolean {
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  const names = new Set(fileNames.filter(Boolean));
  if (lines.every((line) => names.has(line))) return true;
  return lines.length === 1 && !/\s/.test(lines[0]);
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

/** The file's bytes as base64, without a `data:` prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}
