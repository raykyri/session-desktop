import { LoaderCircle } from "lucide-react";
import { nodeRecap, nodeStatus, recapEligible } from "../../lib/researchNodeTypes";
import type { ResearchNodeContent } from "../../types";

function ResearchRecapLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return (
    <p
      className={
        className
          ? `research-recap-text research-recap ${className}`
          : "research-recap-text research-recap"
      }
    >
      Recap: {trimmed}
    </p>
  );
}

/** Reserve the recap's space while generation runs to avoid shifting the answer. */
function ResearchRecapPendingLine() {
  return (
    <p
      className="research-recap-text research-recap research-recap-pending"
      role="status"
      aria-label="Generating recap"
      title="Generating recap"
    >
      <LoaderCircle className="research-spinner" size={13} aria-hidden="true" />
    </p>
  );
}

/** No reserved space for a recap that is absent and not being generated:
 * mount only a completed, current recap, or the pending placeholder. */
export default function ResearchRecap({
  content,
  pending = false,
}: {
  content: ResearchNodeContent;
  /** A background recap job is in flight for this node. */
  pending?: boolean;
}) {
  const { node, responseRevision } = content;
  const recap = nodeRecap(node);
  if (!recapEligible(node) || nodeStatus(node) !== "complete") {
    return null;
  }
  if (
    !recap?.text.trim() ||
    !responseRevision ||
    recap.responseRevision !== responseRevision
  ) {
    return pending ? <ResearchRecapPendingLine /> : null;
  }
  return <ResearchRecapLine text={recap.text} />;
}
