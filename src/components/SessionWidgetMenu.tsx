import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, ExternalLink, Import, RotateCcw } from "lucide-react";
import { researchArtifactHistory, type ResearchArtifactRevision } from "../lib/api";
import { changeArtifactState, type ArtifactStateEntry } from "../lib/sessionArtifactState";
import { ResearchMenu, ResearchMenuItem, ResearchMenuSeparator } from "./research/ResearchMenu";

/** A revision's relation to its parent, as the history rows show it. */
function lineageLabel(entry: ResearchArtifactRevision): string {
  if (entry.unresolvedParent) return "original (declared parent not found)";
  return entry.parentRevision ? `from ${entry.parentRevision.slice(0, 8)}` : "original";
}

type ArtifactHistory =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; revisions: ResearchArtifactRevision[]; unresolved: number };

/** The revision history of a widget's artifact, loaded on request and kept
 * until the revision changes. A failed load is retried on the next request. */
export function useArtifactHistory(revision: ResearchArtifactRevision | null) {
  const key = revision ? JSON.stringify([revision.treeId, revision.artifactId, revision.revision]) : null;
  const [state, setState] = useState<{ key: string | null; history: ArtifactHistory }>({ key, history: { status: "idle" } });
  const keyRef = useRef(key);
  keyRef.current = key;
  const history: ArtifactHistory = state.key === key ? state.history : { status: "idle" };
  const load = useCallback(() => {
    if (!revision || !key) return;
    if (history.status === "loading" || history.status === "ready") return;
    setState({ key, history: { status: "loading" } });
    researchArtifactHistory(revision.treeId, revision.artifactId).then(
      (result) => {
        if (keyRef.current === key) setState({ key, history: { status: "ready", revisions: result.revisions, unresolved: result.unresolved } });
      },
      () => {
        if (keyRef.current === key) setState({ key, history: { status: "error", message: "Revision history unavailable" } });
      },
    );
  }, [revision, key, history.status]);
  return { history, load };
}

/** The menu's 16px leading column: an icon, a check mark, or nothing. */
function Lead({ children }: { children?: ReactNode }) {
  return <span className="session-widget-menu-lead" aria-hidden="true">{children}</span>;
}

function Section({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id}>
      <div id={id} className="session-widget-menu-section" role="presentation">{label}</div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="session-widget-menu-note" role="presentation">{children}</div>;
}

/** The widget's "…" menu: export actions, the artifact's revisions, and the
 * saved-input settings. Items that act close the menu first; toggling
 * Remember inputs and retrying the history load keep it open. */
export default function SessionWidgetMenu({
  anchor,
  idPrefix,
  revision,
  hasScripts,
  stateEntry,
  history,
  onLoadHistory,
  onCopy,
  onDownload,
  onOpenInBrowser,
  onPreviewRevision,
  onClose,
}: {
  anchor: HTMLElement;
  /** Unique per widget, for the section labels' ids. */
  idPrefix: string;
  revision: ResearchArtifactRevision | null;
  hasScripts: boolean;
  stateEntry: ArtifactStateEntry;
  history: ArtifactHistory;
  onLoadHistory: () => void;
  onCopy: () => void;
  onDownload: () => void;
  /** Absent when the widget has no page to open. */
  onOpenInBrowser: (() => void) | null;
  onPreviewRevision: (entry: ResearchArtifactRevision) => void;
  onClose: () => void;
}) {
  const close = (run: () => void) => () => {
    onClose();
    run();
  };
  // Try again is replaced by the loading row, which would leave focus on the
  // document body; focus moves to the first item instead.
  const retriedRef = useRef(false);
  useLayoutEffect(() => {
    if (!retriedRef.current) return;
    retriedRef.current = false;
    if (document.activeElement?.closest('[role="menu"]')) return;
    document.querySelector<HTMLElement>('.session-widget-menu [role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [history.status]);
  const remembered = stateEntry.config?.enabled ?? false;
  const parent = revision?.parentRevision && !revision.unresolvedParent ? revision.parentRevision : null;
  return (
    <ResearchMenu anchor={anchor} align="end" label="Widget actions" className="session-widget-menu" onClose={onClose}>
      <ResearchMenuItem icon={<Lead><Copy size={14} /></Lead>} label="Copy HTML" onSelect={close(onCopy)} />
      <ResearchMenuItem icon={<Lead><Download size={14} /></Lead>} label="Download HTML" onSelect={close(onDownload)} />
      {onOpenInBrowser ? (
        <ResearchMenuItem icon={<Lead><ExternalLink size={14} /></Lead>} label="Open in browser" onSelect={close(onOpenInBrowser)} />
      ) : null}
      {revision ? (
        <>
          <ResearchMenuSeparator />
          <Section id={`${idPrefix}-revisions`} label="Revisions">
            {history.status === "idle" || history.status === "loading" ? <Note>Loading revisions…</Note> : null}
            {history.status === "error" ? (
              <>
                <Note>{history.message}</Note>
                <ResearchMenuItem icon={<Lead><RotateCcw size={14} /></Lead>} label="Try again" onSelect={() => { retriedRef.current = true; onLoadHistory(); }} />
              </>
            ) : null}
            {history.status === "ready" ? (
              <>
                {history.revisions.map((entry) => {
                  const current = entry.revision === revision.revision;
                  return (
                    <ResearchMenuItem
                      key={`${entry.nodeId}:${entry.revision}`}
                      className="session-widget-menu-revision"
                      icon={<Lead>{current ? <Check size={14} /> : null}</Lead>}
                      label={<span className="session-widget-menu-hash">{entry.revision.slice(0, 8)}</span>}
                      trailing={<span className="session-widget-menu-lineage">{lineageLabel(entry)}</span>}
                      current={current}
                      title={`Preview revision ${entry.revision.slice(0, 8)} from answer ${entry.nodeId.slice(0, 8)}`}
                      onSelect={close(() => onPreviewRevision(entry))}
                    />
                  );
                })}
                {history.unresolved > 0 ? (
                  <Note>{`${history.unresolved} source revision(s) could not be stored. Their source exceeds the size limit or could not be saved.`}</Note>
                ) : null}
              </>
            ) : null}
          </Section>
          {hasScripts ? (
            <>
              <ResearchMenuSeparator />
              <Section id={`${idPrefix}-inputs`} label="Saved inputs">
                <ResearchMenuItem
                  icon={<Lead>{remembered ? <Check size={14} /> : null}</Lead>}
                  label="Remember inputs"
                  checked={remembered}
                  checkbox
                  // Disabled until the setting loads. While a change is in
                  // flight the item stays focusable and ignores selection, so
                  // keyboard focus stays in the open menu.
                  disabled={!stateEntry.config}
                  onSelect={() => {
                    if (stateEntry.pending > 0) return;
                    void changeArtifactState(revision, remembered ? "disable" : "enable");
                  }}
                />
                {remembered ? (
                  <>
                    <ResearchMenuItem
                      icon={<Lead><RotateCcw size={14} /></Lead>}
                      label="Reset inputs"
                      disabled={stateEntry.pending > 0}
                      onSelect={close(() => void changeArtifactState(revision, "reset"))}
                    />
                    {parent ? (
                      <ResearchMenuItem
                        icon={<Lead><Import size={14} /></Lead>}
                        label={`Copy inputs from ${parent.slice(0, 8)}`}
                        disabled={stateEntry.pending > 0}
                        title="Replace this revision's saved inputs with the parent's JSON state. Use this only if both revisions use the same input format."
                        onSelect={close(() => void changeArtifactState(revision, "migrate"))}
                      />
                    ) : null}
                  </>
                ) : null}
              </Section>
            </>
          ) : null}
        </>
      ) : null}
    </ResearchMenu>
  );
}
