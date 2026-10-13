import { withArtifactState } from "../lib/sessionArtifactState";
import { useState } from "react";
import { prepareResearchWidget, researchArtifactHistory, type ResearchArtifactRevision } from "../lib/api";
import { registerWidgetUrls } from "../lib/sessionWidgetExecution";

/** How a revision relates to its parent in the history list. */
function lineageLabel(entry: ResearchArtifactRevision): string {
  if (entry.unresolvedParent) return " · parent revision unavailable";
  return entry.parentRevision ? ` · from ${entry.parentRevision.slice(0, 8)}` : " · original";
}

/** The artifact's title, revision and history. The title is generated content:
 * it is rendered as one line of plain text after a fixed "Widget:" label, so
 * it reads as content of the widget, not as Session's interface. */
export default function SessionArtifactDetails({ revision, onOpen }: { revision: ResearchArtifactRevision; onOpen: (url: string) => void }) {
  const [history, setHistory] = useState<ResearchArtifactRevision[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  return <div className="session-artifact-details" data-widget-chrome="">
    <div className="session-artifact-heading"><span className="session-artifact-title" title={revision.title}><span className="session-artifact-label">Widget:</span> {revision.title}</span><span title={revision.revision}>Pinned · {revision.revision.slice(0, 8)}{revision.unresolvedParent ? " · parent revision unavailable" : ""}</span>
      <button type="button" className="research-link-button" disabled={loading} onClick={async () => {
        if (history) { setHistory(null); return; }
        setLoading(true); setError("");
        try { const result = await researchArtifactHistory(revision.treeId, revision.artifactId); setHistory(result.revisions); if (result.unresolved) setError(`${result.unresolved} source revision(s) could not be stored. Their source exceeds the size limit or could not be saved.`); }
        catch { setError("Revision history unavailable. Try again."); }
        finally { setLoading(false); }
      }}>{history ? "Hide revisions" : loading ? "Loading revisions…" : "Revisions"}</button>
    </div>
    {history ? <ul aria-label="Artifact revisions">{history.map((entry) => <li key={`${entry.nodeId}:${entry.revision}`}>
      <button type="button" className="research-link-button" onClick={async () => {
        try { const urls = registerWidgetUrls(await prepareResearchWidget(entry.html)); onOpen(withArtifactState(urls.staticUrl, entry)); }
        catch { setError("Revision preview unavailable. Try again."); }
      }}>Preview {entry.revision.slice(0, 8)}</button>
      <span>Answer {entry.nodeId.slice(0, 8)}{entry.revision === revision.revision ? " · this revision" : ""}{lineageLabel(entry)}</span>
    </li>)}</ul> : null}
    {error ? <p role="status">{error}</p> : null}
  </div>;
}
