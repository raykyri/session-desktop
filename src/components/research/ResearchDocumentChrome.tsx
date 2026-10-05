import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, PanelLeftOpen } from "lucide-react";

interface ResearchHistoryNavProps {
  canGoBack?: boolean;
  canGoForward?: boolean;
  backTitle?: string;
  forwardTitle?: string;
  onBack?: () => void;
  onForward?: () => void;
}

/** Browser-style back/forward pair at the left edge of a research document
 * header. Renders disabled when no handlers/ability are supplied, which is
 * the whole state for placeholder and composer headers. */
export function ResearchHistoryNav({
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

interface ResearchDocumentFrameProps {
  /** Single inert breadcrumb entry naming the page; empty leaves the
   * breadcrumb blank (a placeholder beside a column that names the page). */
  title: string;
  /** Fades the breadcrumb out while keeping its space, for a page whose own
   * heading already names it. */
  titleHidden?: boolean;
  hidden?: boolean;
  /** Extra icon controls rendered beside the back/forward pair, or at the
   * header's trailing edge with `actionsAtEnd`. */
  navActions?: ReactNode;
  /** A list page (Home, Bookmarks, ...) leads with its name and keeps its
   * icon controls at the trailing edge. */
  actionsAtEnd?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
  canGoBack?: boolean;
  canGoForward?: boolean;
  backTitle?: string;
  forwardTitle?: string;
  onBack?: () => void;
  onForward?: () => void;
}

interface ResearchSidebarRestoreButtonProps {
  onClick: () => void;
}

/** Reopens the app sidebar from research chrome, alongside the document's
 * transcript and run controls rather than floating over the research body. */
export function ResearchSidebarRestoreButton({
  onClick,
}: ResearchSidebarRestoreButtonProps) {
  return (
    <button
      type="button"
      className="control-button research-sidebar-restore"
      title="Show left sidebar (⇧⌘G)"
      aria-label="Show left sidebar"
      onClick={onClick}
    >
      <PanelLeftOpen size={15} aria-hidden="true" />
    </button>
  );
}

/** The research-surface page chrome shared by states that are not a live
 * document: the standard header with inert history controls and a one-entry
 * breadcrumb, wrapping whatever body the state renders. The live document
 * view keeps its own header (interactive breadcrumb and run controls) but
 * shares the nav component above. */
export function ResearchDocumentFrame({
  title,
  titleHidden = false,
  hidden = false,
  navActions,
  actionsAtEnd = false,
  headerActions,
  children,
  canGoBack,
  canGoForward,
  backTitle,
  forwardTitle,
  onBack,
  onForward,
}: ResearchDocumentFrameProps) {
  return (
    <div className="research-workspace" hidden={hidden}>
      <main className="research-document">
        <header className="research-document-header">
          <ResearchHistoryNav
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            backTitle={backTitle}
            forwardTitle={forwardTitle}
            onBack={onBack}
            onForward={onForward}
          />
          {actionsAtEnd ? null : navActions}
          <div
            className={`research-breadcrumb${titleHidden ? " is-title-hidden" : ""}`}
            aria-label="Research path"
            aria-hidden={titleHidden ? "true" : undefined}
          >
            {title ? (
              <span>
                <button className="control-button" type="button" disabled>
                  {title}
                </button>
              </span>
            ) : null}
          </div>
          {actionsAtEnd && navActions ? (
            <div className="research-header-actions-end">{navActions}</div>
          ) : null}
          {headerActions}
        </header>
        {children}
      </main>
    </div>
  );
}
