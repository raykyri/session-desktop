// Image attachments in an ask box (the desktop's `ResearchImages.tsx`): a
// strip of thumbnails that open the full image in the lightbox, each with a
// remove button in a composer, and the paste and drop handling that uploads
// each accepted image at once (`POST /api/images`). The limits and messages
// are the desktop's (`lib/researchImages.ts`); the server checks them again.

import type { ResearchImageAttachment } from "@session/shared";
import { researchImageUrl } from "@session/shared";
import { LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";

import { uploadResearchImage } from "../../api/api.js";
import { cn } from "../../lib/cn.js";
import {
  acceptResearchImageFiles,
  dragCarriesFiles,
  filesFromDataTransfer,
  pasteAttachesImages,
  researchImageAlt,
} from "../../lib/researchImages.js";
import { errorMessage } from "../../lib/toast.js";
import { openImageLightbox } from "../../stores/lightboxes.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

/** One attached image: a thumbnail that opens the full image, and in a
 * composer a × that removes it. A missing file shows "Unavailable". */
function ImageThumb({
  image,
  onRemove,
}: {
  image: ResearchImageAttachment;
  onRemove?: (() => void) | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const alt = researchImageAlt(image);
  const aspect = image.width && image.height ? image.width / image.height : null;
  return (
    <div className="relative" title={alt}>
      <button
        type="button"
        className={cn(
          "border-border-subtle bg-surface-inset flex h-14 cursor-zoom-in items-center justify-center overflow-hidden rounded-md border p-0",
          FOCUS_RING,
        )}
        aria-label={`Open image: ${alt}`}
        style={{ aspectRatio: aspect ? String(Math.min(Math.max(aspect, 0.5), 2)) : "1" }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          openImageLightbox({ src: researchImageUrl(image.id), alt });
        }}
      >
        {failed ? (
          <span className="text-fg-muted px-1 text-xs">Unavailable</span>
        ) : (
          <img
            src={researchImageUrl(image.id, { thumbnail: true })}
            alt={alt}
            draggable={false}
            loading="lazy"
            decoding="async"
            className="block h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
      </button>
      {onRemove ? (
        <button
          type="button"
          className={cn(
            "border-border-control bg-control text-fg-secondary hover:bg-control-hover absolute -top-1.5 -right-1.5 grid size-[18px] place-items-center rounded-full border p-0",
            FOCUS_RING,
          )}
          aria-label={`Remove image: ${alt}`}
          title="Remove image"
          onClick={onRemove}
        >
          <X size={11} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** The images of a message or a composer (with remove buttons and a
 * placeholder for each image still uploading). Null without either. */
export function ImageStrip({
  images,
  saving = 0,
  onRemove,
  className,
}: {
  images: readonly ResearchImageAttachment[];
  saving?: number;
  onRemove?: ((id: string) => void) | undefined;
  className?: string;
}) {
  if (images.length === 0 && saving === 0) return null;
  return (
    <ul
      className={cn("m-0 flex list-none flex-wrap gap-2 p-0 pt-1.5 pb-1", className)}
      aria-label={images.length === 1 ? "Attached image" : "Attached images"}
    >
      {images.map((image) => (
        <li key={image.id}>
          <ImageThumb image={image} onRemove={onRemove ? () => onRemove(image.id) : undefined} />
        </li>
      ))}
      {Array.from({ length: saving }, (_, index) => (
        <li key={`saving-${index}`}>
          <div
            className="border-border-subtle bg-surface-inset grid size-14 place-items-center rounded-md border"
            aria-label="Attaching image"
            role="status"
          >
            <LoaderCircle className="session-spin text-fg-muted" size={14} aria-hidden="true" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export type ImagesUpdate = (
  update: (current: readonly ResearchImageAttachment[]) => ResearchImageAttachment[],
) => void;

/** Paste and drop handling for a composer's field. Each accepted image is
 * uploaded at once and added through `onImagesChange`; `saving` counts the
 * images still uploading and `error` is the message for the last rejected
 * file or failed upload. Without `onImagesChange` the field takes no images.
 * The returned `fieldProps` go on the composer's root element, which is
 * marked `data-research-image-drop` so Home's report drop leaves its drops
 * alone. */
export function useImageInput({
  images,
  onImagesChange,
  disabled = false,
}: {
  images: readonly ResearchImageAttachment[];
  onImagesChange?: ImagesUpdate | undefined;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const enabled = Boolean(onImagesChange) && !disabled;
  const countRef = useRef(0);
  const onChangeRef = useRef(onImagesChange);
  useLayoutEffect(() => {
    countRef.current = images.length + saving;
    onChangeRef.current = onImagesChange;
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const { accepted, error: rejected } = acceptResearchImageFiles(files, countRef.current);
    setError(rejected);
    if (accepted.length === 0) return;
    setSaving((current) => current + accepted.length);
    countRef.current += accepted.length;
    void (async () => {
      for (const file of accepted) {
        try {
          const image = await uploadResearchImage(file, file.name || undefined);
          if (!mountedRef.current) continue;
          onChangeRef.current?.((current) =>
            current.some((entry) => entry.id === image.id) ? [...current] : [...current, image],
          );
        } catch (failure) {
          if (mountedRef.current) setError(errorMessage(failure));
        } finally {
          if (mountedRef.current) setSaving((current) => current - 1);
        }
      }
    })();
  }, []);

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      if (
        !pasteAttachesImages(
          text,
          files.map((file) => file.name),
          html,
        )
      ) {
        return;
      }
      event.preventDefault();
      addFiles(files);
    },
    [addFiles, enabled],
  );
  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );
  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      const files = filesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    },
    [addFiles, enabled],
  );
  const remove = useCallback((id: string) => {
    setError(null);
    onChangeRef.current?.((current) => current.filter((image) => image.id !== id));
  }, []);

  return {
    saving,
    error,
    clearError: useCallback(() => setError(null), []),
    remove,
    fieldProps: enabled
      ? { onPaste, onDragOver, onDrop, "data-research-image-drop": "" }
      : { "data-research-image-drop": "" },
  };
}
