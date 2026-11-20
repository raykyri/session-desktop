// The one-line recap above a settled answer (`09-research-document-view.md`
// §2), ported from the desktop `ResearchRecap.tsx`. Shown only for a complete
// run whose recap was generated against the revision on screen, so a stale
// recap never describes a rerun answer. While a background recap job runs,
// a spinner holds its place.

import type { ResearchNodeContent } from "@session/shared";
import { nodeRecap, nodeStatus, recapEligible } from "@session/shared/lib/researchNodeTypes";
import { LoaderCircle } from "lucide-react";

export function Recap({ content, pending }: { content: ResearchNodeContent; pending: boolean }) {
  const { node, responseRevision } = content;
  if (!recapEligible(node) || nodeStatus(node) !== "complete") return null;
  const recap = nodeRecap(node);
  if (!recap?.text.trim() || !responseRevision || recap.responseRevision !== responseRevision) {
    return pending ? (
      <p
        className="research-summary-text research-recap-text mb-6"
        role="status"
        aria-label="Generating recap"
        title="Generating recap"
      >
        <LoaderCircle className="session-spin" size={13} aria-hidden="true" />
      </p>
    ) : null;
  }
  return (
    <p className="research-summary-text research-recap-text mb-7">Recap: {recap.text.trim()}</p>
  );
}
