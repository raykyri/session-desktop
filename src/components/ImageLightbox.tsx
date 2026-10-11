import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  closeImageLightbox,
  getImageLightbox,
  subscribeImageLightbox,
} from "../lib/imageLightbox";

// Mounted once at the app root. Displays the selected image over a backdrop.
// The app-level dispatcher handles Escape according to overlay order. The
// selected data URL is already loaded, so the lightbox needs no loading state.
export default function ImageLightbox() {
  const state = useSyncExternalStore(subscribeImageLightbox, getImageLightbox, getImageLightbox);

  if (!state) {
    return null;
  }
  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={state.alt}
      onClick={closeImageLightbox}
    >
      <button
        type="button"
        className="image-lightbox-close control-button"
        aria-label="Close image"
        onClick={closeImageLightbox}
      >
        ✕
      </button>
      {/* Stop the click on the image itself from dismissing, so only the
          backdrop (and the explicit close button) close the lightbox. */}
      <img
        className="image-lightbox-img"
        src={state.src}
        alt={state.alt}
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
