// The app-wide image and diagram lightboxes, ported from the desktop
// `src/lib/imageLightbox.ts` and `diagramLightbox.ts` (07 §4.3, §7).
//
// These stay module-level `useSyncExternalStore` stores rather than Zustand
// slices, exactly as on the desktop: an image nested deep in rendered markdown
// opens the lightbox with a bare import, without threading a callback through
// the render tree, and a plain subscriber set is the whole implementation.
// `AppShell` mounts both components once and registers them on the escape
// stack.

export interface ImageLightboxState {
  /** Already loaded and encoded by the caller, so opening is instant. */
  src: string;
  alt: string;
}

export interface DiagramLightboxState {
  lang: "mermaid" | "dot";
  label: string;
  /** Already rendered and DOMPurify-sanitized by the diagram block, so the
   * expanded view shows the exact bytes already on screen. */
  svg: string;
}

function createLightboxStore<T>() {
  let current: T | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  // Arrow properties rather than methods: the exports below hand these to
  // `useSyncExternalStore` and to `onClick`, detached from the object.
  return {
    open: (state: T) => {
      current = state;
      emit();
    },
    close: () => {
      if (current === null) return;
      current = null;
      emit();
    },
    get: (): T | null => current,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const imageStore = createLightboxStore<ImageLightboxState>();
const diagramStore = createLightboxStore<DiagramLightboxState>();

export const openImageLightbox = imageStore.open;
export const closeImageLightbox = imageStore.close;
export const getImageLightbox = imageStore.get;
export const subscribeImageLightbox = imageStore.subscribe;

export const openDiagramLightbox = diagramStore.open;
export const closeDiagramLightbox = diagramStore.close;
export const getDiagramLightbox = diagramStore.get;
export const subscribeDiagramLightbox = diagramStore.subscribe;
