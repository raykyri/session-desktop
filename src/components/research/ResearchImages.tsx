import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LoaderCircle, X } from "lucide-react";
import type { ResearchImageAttachment } from "../../types";
import { importResearchImage, readResearchImage, saveResearchImage } from "../../lib/api";
import { openImageLightbox } from "../../lib/imageLightbox";
import {
  acceptResearchImageFiles,
  blobToBase64,
  dragCarriesFiles,
  filesFromDataTransfer,
  RESEARCH_IMAGE_COUNT_ERROR,
  RESEARCH_IMAGE_MAX_COUNT,
  researchImageAlt,
} from "../../lib/researchImages";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Data URLs of recently shown images, most recent last. The webview's
// content security policy allows only data: and blob: image sources.
const MAX_CACHED_IMAGES = 24;
const imageUrls = new Map<string, Promise<string>>();

function loadImageUrl(id: string): Promise<string> {
  const cached = imageUrls.get(id);
  if (cached) {
    imageUrls.delete(id);
    imageUrls.set(id, cached);
    return cached;
  }
  const loading = readResearchImage(id);
  imageUrls.set(id, loading);
  loading.catch(() => imageUrls.delete(id));
  while (imageUrls.size > MAX_CACHED_IMAGES) {
    const oldest = imageUrls.keys().next().value;
    if (oldest === undefined) break;
    imageUrls.delete(oldest);
  }
  return loading;
}

function useImageUrl(id: string) {
  const [state, setState] = useState<{ id: string; url: string | null; failed: boolean }>({
    id,
    url: null,
    failed: false,
  });
  useEffect(() => {
    let disposed = false;
    setState({ id, url: null, failed: false });
    loadImageUrl(id).then(
      (url) => {
        if (!disposed) setState({ id, url, failed: false });
      },
      () => {
        if (!disposed) setState({ id, url: null, failed: true });
      },
    );
    return () => {
      disposed = true;
    };
  }, [id]);
  return state.id === id ? state : { url: null, failed: false };
}

/** One attached image: a thumbnail that opens the image lightbox, and, in
 * a composer, a × that removes it. A missing file shows "Unavailable". */
function ResearchImageThumb({
  image,
  onRemove,
}: {
  image: ResearchImageAttachment;
  onRemove?: () => void;
}) {
  const { url, failed } = useImageUrl(image.id);
  const alt = researchImageAlt(image);
  const aspect = image.width && image.height ? image.width / image.height : null;
  return (
    <div className="research-image" title={alt}>
      <button
        type="button"
        className="research-image-open"
        aria-label={`Open image: ${alt}`}
        disabled={!url}
        style={aspect ? { aspectRatio: String(Math.min(Math.max(aspect, 0.5), 2)) } : undefined}
        // The thumbnail sits in clickable rows; opening the image does not
        // also select the row.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (url) openImageLightbox({ src: url, alt });
        }}
      >
        {url ? (
          <img src={url} alt={alt} draggable={false} />
        ) : (
          <span className="research-image-status">{failed ? "Unavailable" : null}</span>
        )}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="control-button research-image-remove"
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

/** The images of a message, or of a composer (with remove buttons and a
 * placeholder for each image still being saved). Null without either. */
export function ResearchImageStrip({
  images,
  saving = 0,
  onRemove,
  className,
}: {
  images: readonly ResearchImageAttachment[];
  saving?: number;
  onRemove?: (id: string) => void;
  className?: string;
}) {
  if (images.length === 0 && saving === 0) return null;
  return (
    <ul
      className={`research-image-strip${className ? ` ${className}` : ""}`}
      aria-label={images.length === 1 ? "Attached image" : "Attached images"}
    >
      {images.map((image) => (
        <li key={image.id}>
          <ResearchImageThumb image={image} onRemove={onRemove ? () => onRemove(image.id) : undefined} />
        </li>
      ))}
      {Array.from({ length: saving }, (_, index) => (
        <li key={`saving-${index}`}>
          <div className="research-image is-saving" aria-label="Attaching image" role="status">
            <LoaderCircle className="research-spinner" size={14} aria-hidden="true" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export type ResearchImagesUpdate = (
  update: (current: readonly ResearchImageAttachment[]) => ResearchImageAttachment[],
) => void;

/** Paste and drop handling for a composer's field. Each accepted image is
 * saved at once and added through `onImagesChange`; `saving` counts the
 * images still being saved and `error` names the last rejected file.
 * `dropTarget` is the element native file drops (which arrive as paths)
 * must land on. Without `onImagesChange` the field takes no images. */
export function useResearchImageInput({
  images,
  onImagesChange,
  disabled = false,
  dropTarget,
}: {
  images: readonly ResearchImageAttachment[];
  onImagesChange?: ResearchImagesUpdate;
  disabled?: boolean;
  dropTarget: RefObject<HTMLElement | null>;
}) {
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const enabled = Boolean(onImagesChange) && !disabled;
  const countRef = useRef(0);
  countRef.current = images.length + saving;
  const onChangeRef = useRef(onImagesChange);
  onChangeRef.current = onImagesChange;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addAll = useCallback(async (count: number, save: (index: number) => Promise<ResearchImageAttachment>) => {
    setSaving((current) => current + count);
    countRef.current += count;
    for (let index = 0; index < count; index += 1) {
      try {
        const image = await save(index);
        if (!mountedRef.current) continue;
        onChangeRef.current?.((current) =>
          current.some((entry) => entry.id === image.id) ? [...current] : [...current, image],
        );
      } catch (err) {
        if (mountedRef.current) setError(errorMessage(err));
      } finally {
        if (mountedRef.current) setSaving((current) => current - 1);
      }
    }
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const { accepted, error: rejected } = acceptResearchImageFiles(files, countRef.current);
      setError(rejected);
      if (accepted.length === 0) return;
      void addAll(accepted.length, async (index) => {
        const file = accepted[index];
        return saveResearchImage(await blobToBase64(file), file.name || null);
      });
    },
    [addAll],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
      const room = Math.max(0, RESEARCH_IMAGE_MAX_COUNT - countRef.current);
      setError(paths.length > room ? RESEARCH_IMAGE_COUNT_ERROR : null);
      const accepted = paths.slice(0, room);
      if (accepted.length === 0) return;
      void addAll(accepted.length, (index) => importResearchImage(accepted[index]));
    },
    [addAll],
  );

  // Native file drops: the window delivers them as paths with a position.
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        const target = dropTarget.current;
        if (payload.type !== "drop" || !target || payload.paths.length === 0) return;
        const rect = target.getBoundingClientRect();
        const x = payload.position.x / window.devicePixelRatio;
        const y = payload.position.y / window.devicePixelRatio;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        addPaths(payload.paths);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths, dropTarget, enabled]);

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      // An image copied from a page also carries its URL or markup as text;
      // the image replaces that text. Text copied with an image keeps both.
      if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
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
    fieldProps: enabled ? { onPaste, onDragOver, onDrop } : {},
  };
}
