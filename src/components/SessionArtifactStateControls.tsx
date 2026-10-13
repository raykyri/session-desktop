import type { ResearchArtifactRevision } from "../lib/api";
import { changeArtifactState, loadArtifactState, type ArtifactStateEntry } from "../lib/sessionArtifactState";

export default function SessionArtifactStateControls({ revision, entry }: { revision: ResearchArtifactRevision; entry: ArtifactStateEntry }) {
  return <div className="session-artifact-state" data-widget-chrome="">
    <label><input type="checkbox" checked={entry.config?.enabled ?? false} disabled={!entry.config || entry.pending > 0} onChange={(event) => void changeArtifactState(revision, event.target.checked ? "enable" : "disable")} /> Remember inputs for this revision</label>
    {entry.config?.enabled ? <>
      <button type="button" className="research-link-button" disabled={entry.pending > 0} onClick={() => void changeArtifactState(revision, "reset")}>Reset inputs</button>
      {revision.parentRevision && !revision.unresolvedParent ? <button type="button" className="research-link-button" disabled={entry.pending > 0} title="Replace this revision's saved inputs with the parent's JSON state. Use this only if both revisions use the same input format." onClick={() => void changeArtifactState(revision, "migrate")}>Copy parent inputs</button> : null}
    </> : null}
    {entry.error ? <span role="status">{entry.error} {entry.config?.enabled ? <button type="button" disabled={entry.pending > 0} onClick={() => void changeArtifactState(revision, "save", entry.config?.value)}>Retry saving</button> : null} {!entry.config ? <button type="button" onClick={() => void loadArtifactState(revision)}>Retry</button> : null}</span> : null}
  </div>;
}
