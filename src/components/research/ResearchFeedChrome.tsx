import { useEffect, useRef } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import { Archive, ChevronLeft, FilePen, Folder, X } from "lucide-react";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
} from "../../lib/researchFolders";
import type { ResearchToast } from "../../hooks/useResearchToast";

/** The icon of a place: Drafts and Archive have their own, user folders share one. */
export function ResearchPlaceIcon({ place, size = 14 }: { place: string; size?: number }) {
  if (place === RESEARCH_DRAFTS_FOLDER_ID) return <FilePen size={size} aria-hidden="true" />;
  if (place === RESEARCH_ARCHIVE_FOLDER_ID) return <Archive size={size} aria-hidden="true" />;
  return <Folder size={size} aria-hidden="true" />;
}

/** The feed column's 44px title bar: an optional back button, the view's
 * name, and trailing actions. The bar (not its buttons) moves the window. */
export function ResearchFeedHeader({
  title,
  titleRef,
  onBack,
  actions,
}: {
  title: string;
  titleRef?: Ref<HTMLHeadingElement>;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="research-feed-header">
      <div className="research-feed-header-bar" data-tauri-drag-region>
        {onBack ? (
          <button
            type="button"
            className="research-feed-icon-button"
            title="Back to Home"
            aria-label="Back to Home"
            onClick={onBack}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        ) : null}
        <h2
          ref={titleRef}
          className="research-feed-header-title"
          tabIndex={-1}
          data-tauri-drag-region
        >
          {title}
        </h2>
        <span className="research-feed-header-spacer" data-tauri-drag-region />
        {actions}
      </div>
    </header>
  );
}

/** Bottom-centred status for feed and folder actions, with Undo for moves.
 * The live region stays mounted so screen readers announce each new message;
 * the toast's timer pauses while the pointer or focus is on it. */
export function ResearchFeedToast({
  toast,
  onUndo,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: ResearchToast | null;
  onUndo: () => void;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  return (
    <div className="research-feed-toast-region" role="status" aria-live="polite">
      {toast ? (
        <div
          key={toast.id}
          className={`research-feed-toast${toast.tone === "warning" ? " is-warning" : ""}`}
          onPointerEnter={onPause}
          onPointerLeave={onResume}
          onFocus={onPause}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onResume();
          }}
        >
          <span className="research-feed-toast-message">{toast.message}</span>
          {toast.undo ? (
            <button type="button" className="research-feed-button is-ghost" onClick={onUndo}>
              Undo
            </button>
          ) : null}
          <button
            type="button"
            className="research-feed-icon-button"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The feed's scrollbar: the native one is hidden so the column's width never
 * depends on the system setting, and this thin thumb is drawn over the right
 * edge on hover and while scrolling. */
export function ResearchFeedScrollThumb({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const thumbRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !thumb) return;
    let hideTimer = 0;
    const update = (active: boolean) => {
      const height = scroller.clientHeight;
      const total = scroller.scrollHeight;
      thumb.hidden = total <= height + 1;
      if (thumb.hidden) return;
      const length = Math.max(28, (height * height) / total);
      thumb.style.height = `${length}px`;
      thumb.style.top = `${
        scroller.offsetTop + 2 + ((height - length - 4) * scroller.scrollTop) / (total - height)
      }px`;
      if (!active) return;
      thumb.classList.add("is-active");
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => thumb.classList.remove("is-active"), 900);
    };
    const onScroll = () => update(true);
    update(false);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update(false));
    observer?.observe(scroller);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    return () => {
      window.clearTimeout(hideTimer);
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scrollRef]);
  return <div ref={thumbRef} className="research-feed-scroll-thumb" aria-hidden="true" />;
}
