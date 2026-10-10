import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Plus, Terminal } from "lucide-react";
import { ResearchBranchIcon } from "./ResearchIcons";
import { columnAttributes } from "../../lib/researchColumns";

/** The header bar of one level's pair. It spans the messages and answer
 * columns: the conversation's title (or "Branch · N messages"), clamped to
 * four lines, and "+ Ask" at the right, which jumps to the level's ask box.
 * The bar is a window drag region; its buttons are not. */
export function ResearchPairHeader({
  title,
  branch = null,
  history,
  imported = false,
  archived = false,
  onAsk,
}: {
  title: string;
  /** A branch: its number of messages ("Branch · 2 messages"), or "new" for
   * a branch not yet sent ("New branch"). */
  branch?: number | "new" | null;
  /** Back and forward, in the root conversation's header. */
  history?: ResearchHistoryNavProps | null;
  /** A point-in-time copy of a terminal conversation. */
  imported?: boolean;
  archived?: boolean;
  onAsk?: () => void;
}) {
  return (
    <header className={`research-column-header${branch !== null ? " is-branch" : ""}`}>
      <div className="research-column-bar" data-tauri-drag-region data-research-header-bar>
        {history ? <ResearchHistoryNav {...history} /> : null}
        <h2 className="research-column-title" tabIndex={-1} title={title}>
          {branch !== null ? (
            <>
              <ResearchBranchIcon size={13} className="research-column-title-icon" />
              {branch === "new" ? "New branch" : "Branch"}
              {typeof branch === "number" && branch > 0 ? (
                <span className="research-column-count">
                  {" "}
                  · {branch} {branch === 1 ? "message" : "messages"}
                </span>
              ) : null}
            </>
          ) : (
            title
          )}
        </h2>
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
        {onAsk ? (
          <button
            type="button"
            className="control-button research-head-button"
            aria-label="Go to the ask box"
            onClick={onAsk}
          >
            <Plus size={13} aria-hidden="true" />
            Ask
          </button>
        ) : null}
      </div>
    </header>
  );
}

interface ResearchHistoryNavProps {
  canGoBack: boolean;
  canGoForward: boolean;
  backTitle: string;
  forwardTitle: string;
  onBack: () => void;
  onForward: () => void;
}

/** Browser-style back/forward pair in the root conversation's header. */
function ResearchHistoryNav({
  canGoBack,
  canGoForward,
  backTitle,
  forwardTitle,
  onBack,
  onForward,
}: ResearchHistoryNavProps) {
  return (
    <div className="research-history-nav" role="group" aria-label="Research history">
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

/** A thread that is loading or failed to load: a pair-wide column with the
 * header bar, with the title when there is one, over the given body. */
export function ResearchDocumentFrame({
  title = "",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="research-workspace research-placeholder-column"
      {...columnAttributes({ id: "placeholder", role: "placeholder" })}
    >
      <header className="research-column-header">
        <div className="research-column-bar" data-tauri-drag-region data-research-header-bar>
          {title ? (
            <h2 className="research-column-title" title={title}>
              {title}
            </h2>
          ) : null}
        </div>
      </header>
      {children}
    </section>
  );
}
