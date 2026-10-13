import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LoaderCircle, X } from "lucide-react";
import type { ResearchImageAttachment } from "../../types";
import {
  importResearchImage,
  readResearchImage,
  readResearchImageThumbnail,
  saveResearchImage,
} from "../../lib/api";
import { openImageLightbox } from "../../lib/imageLightbox";
import {
  acceptResearchImageFiles,
  blobToBase64,
  dragCarriesFiles,
  filesFromDataTransfer,
  pasteAttachesImages,
  researchDropKey,
  RESEARCH_IMAGE_COUNT_ERROR,
  RESEARCH_IMAGE_MAX_COUNT,
  researchImageAlt,
} from "../../lib/researchImages";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A file drop can reach the page both as a DOM drop and as the window's
 * native drop. A second drop of the same file names within this window is
 * the same drop; a drop of other files is not. */
const DUPLICATE_DROP_MS = 1_000;

// Data URLs of recently shown thumbnails and full images, most recent
// last, kept to a total length. The webview's content security policy allows
// only data: and blob: image sources.
const MAX_CACHED_URL_LENGTH = 32 * 1024 * 1024;
type ImageSize = "thumbnail" | "full";
const imageUrls = new Map<string, { url: Promise<string>; length: number }>();
let cachedLength = 0;

function evictImageUrls() {
  for (const [key, entry] of imageUrls) {
    if (cachedLength <= MAX_CACHED_URL_LENGTH || imageUrls.size <= 1) break;
    imageUrls.delete(key);
    cachedLength -= entry.length;
  }
}

function loadImageUrl(id: string, size: ImageSize): Promise<string> {
  const key = `${size}:${id}`;
  const cached = imageUrls.get(key);
  if (cached) {
    imageUrls.delete(key);
    imageUrls.set(key, cached);
    return cached.url;
  }
  const loading = size === "thumbnail" ? readResearchImageThumbnail(id) : readResearchImage(id);
  const entry = { url: loading, length: 0 };
  imageUrls.set(key, entry);
  loading.then(
    (url) => {
      if (imageUrls.get(key) !== entry) return;
      entry.length = url.length;
      cachedLength += url.length;
      evictImageUrls();
    },
    () => {
      if (imageUrls.get(key) === entry) imageUrls.delete(key);
    },
  );
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
    loadImageUrl(id, "thumbnail").then(
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

/** One attached image: a thumbnail that opens the full image in the
 * lightbox, and, in a composer, a × that removes it. A missing file shows
 * "Unavailable". */
function ResearchImageThumb({
  image,
  tabIndex,
  onRemove,
}: {
  image: ResearchImageAttachment;
  tabIndex?: number;
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
        tabIndex={tabIndex}
        style={aspect ? { aspectRatio: String(Math.min(Math.max(aspect, 0.5), 2)) } : undefined}
        // The thumbnail sits in clickable rows; opening the image does not
        // also select the row.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (!url) return;
          loadImageUrl(image.id, "full").then(
            (src) => openImageLightbox({ src, alt }),
            () => openImageLightbox({ src: url, alt }),
          );
        }}
      >
        {url ? (
          <img src={url} alt={alt} draggable={false} loading="lazy" decoding="async" />
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
 * placeholder for each image still being saved). Null without either.
 * `tabIndex` follows the row's tab stop in a list with one. */
export function ResearchImageStrip({
  images,
  saving = 0,
  onRemove,
  className,
  tabIndex,
}: {
  images: readonly ResearchImageAttachment[];
  saving?: number;
  onRemove?: (id: string) => void;
  className?: string;
  tabIndex?: number;
}) {
  if (images.length === 0 && saving === 0) return null;
  return (
    <ul
      className={`research-image-strip${className ? ` ${className}` : ""}`}
      aria-label={images.length === 1 ? "Attached image" : "Attached images"}
    >
      {images.map((image) => (
        <li key={image.id}>
          <ResearchImageThumb
            image={image}
            tabIndex={tabIndex}
            onRemove={onRemove ? () => onRemove(image.id) : undefined}
          />
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
  const lastDropRef = useRef<{ at: number; names: string } | null>(null);
  /** Records a drop of files with these names, and returns whether it
   * repeats the last one. */
  const repeatsLastDrop = useCallback((names: readonly string[]) => {
    const key = researchDropKey(names);
    const last = lastDropRef.current;
    const now = Date.now();
    lastDropRef.current = { at: now, names: key };
    return Boolean(last && last.names === key && now - last.at < DUPLICATE_DROP_MS);
  }, []);
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
        const x = payload.position.x / window.devicePixelRatio;
        const y = payload.position.y / window.devicePixelRatio;
        // The element on top at the drop point must be in the composer: a
        // dialog or the image lightbox over it takes the drop instead.
        const topmost = document.elementFromPoint(x, y);
        if (!topmost || !target.contains(topmost)) return;
        if (repeatsLastDrop(payload.paths)) return;
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
  }, [addPaths, dropTarget, enabled, repeatsLastDrop]);

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      if (!pasteAttachesImages(text, files.map((file) => file.name), html)) return;
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
      if (repeatsLastDrop(files.map((file) => file.name))) return;
      addFiles(files);
    },
    [addFiles, enabled, repeatsLastDrop],
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
