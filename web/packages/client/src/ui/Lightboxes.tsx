import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
  closeDiagramLightbox,
  closeImageLightbox,
  getDiagramLightbox,
  getImageLightbox,
  subscribeDiagramLightbox,
  subscribeImageLightbox,
} from "../stores/lightboxes.js";

import { IconButton } from "./Button.js";

// Both lightboxes are Base UI dialogs rather than hand-rolled overlays, so the
// library owns the focus trap, the scroll lock, the portal, and Escape with
// correct nesting (07 §4.4, ADR-9). That is also why neither registers on the
// `overlays` escape stack: the stack is for the layers Base UI does *not* own,
// and a library layer that also registered would be dismissed twice.
//
// They do not use the `Dialog` wrapper. Its surface is a 440 px panel with a
// title, a description and a footer — right for a confirm, wrong for content
// that wants the whole viewport and supplies its own caption.

/** Darker than the dialog scrim: a lightbox is meant to leave the page behind
 * it barely legible. */
const LIGHTBOX_SCRIM = "fixed inset-0 bg-surface-lightbox-scrim";

const LIGHTBOX_POPUP =
  "fixed inset-0 z-(--z-dialog) flex items-center justify-center p-6 outline-none";

const CLOSE_BUTTON = "text-fg-max absolute top-4 right-4";

/**
 * Mounted once at the app root. Renders whatever image `openImageLightbox` last
 * set, over a dimmed backdrop; dismissed by clicking the backdrop, the close
 * button, or Escape. Ported from the desktop `ImageLightbox.tsx`.
 *
 * The image is an already-loaded data URL, so there is no loading state: the
 * thumbnail the user clicked shares the same cached bytes.
 */
export function ImageLightbox() {
  const state = useSyncExternalStore(subscribeImageLightbox, getImageLightbox, getImageLightbox);

  return (
    <BaseDialog.Root
      open={state !== null}
      onOpenChange={(next) => {
        if (!next) closeImageLightbox();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={LIGHTBOX_SCRIM} />
        <BaseDialog.Popup className={LIGHTBOX_POPUP} aria-label={state?.alt ?? "Image"}>
          <IconButton label="Close image" className={CLOSE_BUTTON} onClick={closeImageLightbox}>
            <X size={18} aria-hidden="true" />
          </IconButton>
          {state ? (
            <img className="max-h-full max-w-full object-contain" src={state.src} alt={state.alt} />
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/**
 * The diagram counterpart, ported from `DiagramLightbox.tsx`. The SVG is
 * already rendered and DOMPurify-sanitized by the diagram block, so expanding
 * reuses the exact bytes already on screen.
 */
export function DiagramLightbox() {
  const state = useSyncExternalStore(
    subscribeDiagramLightbox,
    getDiagramLightbox,
    getDiagramLightbox,
  );

  return (
    <BaseDialog.Root
      open={state !== null}
      onOpenChange={(next) => {
        if (!next) closeDiagramLightbox();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={LIGHTBOX_SCRIM} />
        <BaseDialog.Popup
          className={LIGHTBOX_POPUP}
          aria-label={state ? `Expanded ${state.label} diagram` : "Diagram"}
        >
          <IconButton label="Close diagram" className={CLOSE_BUTTON} onClick={closeDiagramLightbox}>
            <X size={18} aria-hidden="true" />
          </IconButton>
          {state ? (
            <div className="border-border-strong bg-surface-code flex max-h-full max-w-full flex-col overflow-auto rounded-md border">
              <div className="border-border-divider bg-surface-code-header text-fg-subtle border-b px-2 py-1 font-mono text-xs tracking-wider uppercase">
                {state.label}
              </div>
              {/* Reuses `.research-diagram-svg` so the expanded diagram renders
                  exactly like the inline one. Links inside the SVG stay
                  clickable in the inline view; this surface is for reading, so
                  the sanitizer's inert hrefs are left inert. */}
              <div
                className="research-diagram-svg"
                data-lang={state.lang}
                dangerouslySetInnerHTML={{ __html: state.svg }}
              />
            </div>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
