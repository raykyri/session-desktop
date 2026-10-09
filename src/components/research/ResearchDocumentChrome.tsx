import type { ReactNode, Ref } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bookmark,
  ChevronLeft,
  Folder,
  Terminal,
  X,
} from "lucide-react";

/** The conversation column's header: one 44px bar (it grows when the title
 * wraps to two or three lines) with history controls, the title, and Follow,
 * Move to folder, Bookmark and Close, always visible. The bar is a window
 * drag region; its buttons are not. */
export function ResearchConversationHeader({
  title,
  titleRef,
  canGoBack,
  canGoForward,
  backTitle,
  forwardTitle,
  onBack,
  onForward,
  imported,
  archived,
  followed,
  bookmarked,
  onToggleFollow,
  onToggleBookmark,
  onMove,
  onClose,
  onColumnBack,
  onFocusColumn,
}: {
  title: string;
  titleRef?: Ref<HTMLHeadingElement>;
  canGoBack: boolean;
  canGoForward: boolean;
  backTitle: string;
  forwardTitle: string;
  onBack: () => void;
  onForward: () => void;
  /** A point-in-time copy of a terminal conversation. */
  imported: boolean;
  archived: boolean;
  followed: boolean;
  bookmarked: boolean;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
  onMove?: (trigger: HTMLButtonElement) => void;
  onClose?: () => void;
  /** Single-column mode: back to the previous column. */
  onColumnBack?: () => void;
  onFocusColumn?: () => void;
}) {
  return (
    <header className="research-column-header is-root" onMouseDown={onFocusColumn}>
      <div className="research-column-bar" data-tauri-drag-region>
        {onColumnBack ? (
          <button
            type="button"
            className="control-button research-icon-button"
            aria-label="Back"
            onClick={onColumnBack}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        ) : null}
        <ResearchHistoryNav
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          backTitle={backTitle}
          forwardTitle={forwardTitle}
          onBack={onBack}
          onForward={onForward}
        />
        <h2 ref={titleRef} className="research-column-title" tabIndex={-1} title={title}>
          {title}
        </h2>
        <span className="research-column-actions">
          {imported ? (
            <span
              className="research-provenance-badge"
              title="This is a point-in-time copy of an imported conversation."
            >
              <Terminal size={12} aria-hidden="true" />
              Imported conversation
            </span>
          ) : null}
          {archived ? <span className="research-archived-label">Archived</span> : null}
          <button
            type="button"
            className={`control-button research-icon-button${followed && !archived ? " is-on" : ""}`}
            disabled={archived}
            aria-pressed={archived ? undefined : followed}
            aria-label={archived ? "Follow, unavailable while archived" : "Follow"}
            title={
              archived
                ? "Archived questions don't send notifications"
                : followed
                  ? "Following: you get notified of replies"
                  : "Follow"
            }
            onClick={onToggleFollow}
          >
            <Bell size={15} aria-hidden="true" fill={followed && !archived ? "currentColor" : "none"} />
          </button>
          {onMove ? (
            <button
              type="button"
              className="control-button research-icon-button"
              aria-label="Move to folder"
              aria-haspopup="menu"
              title="Move to folder"
              onClick={(event) => onMove(event.currentTarget)}
            >
              <Folder size={15} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className={`control-button research-icon-button${bookmarked ? " is-on" : ""}`}
            aria-pressed={bookmarked}
            aria-label="Bookmark"
            title={bookmarked ? "Remove bookmark" : "Bookmark"}
            onClick={onToggleBookmark}
          >
            <Bookmark size={15} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
          </button>
          {onClose ? (
            <button
              type="button"
              className="control-button research-icon-button"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>
    </header>
  );
}

interface ResearchHistoryNavProps {
  canGoBack?: boolean;
  canGoForward?: boolean;
  backTitle?: string;
  forwardTitle?: string;
  onBack?: () => void;
  onForward?: () => void;
}

/** Browser-style back/forward pair in the conversation header. */
function ResearchHistoryNav({
  canGoBack = false,
  canGoForward = false,
  backTitle,
  forwardTitle,
  onBack,
  onForward,
}: ResearchHistoryNavProps) {
  return (
    <div className="research-history-nav" aria-label="Research history">
      <button
        type="button"
        className="control-button research-history-button"
        disabled={!canGoBack}
        title={backTitle}
        aria-label="Back"
        onClick={onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="control-button research-history-button"
        disabled={!canGoForward}
        title={forwardTitle}
        aria-label="Forward"
        onClick={onForward}
      >
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** A content column without a live document (the "No question open"
 * placeholder, a thread that is loading or failed to load): the column
 * header bar, with the title when there is one, over the given body. */
export function ResearchDocumentFrame({
  title = "",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="research-workspace research-placeholder-column">
      <header className="research-column-header is-root">
        <div className="research-column-bar" data-tauri-drag-region>
          {title ? (
            <h2 className="research-column-title" title={title}>
              {title}
            </h2>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}
