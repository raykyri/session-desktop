import type { ResearchNodeContent } from "../../types";
import { RefreshCw } from "lucide-react";

export function ResearchRecapLine({
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
          ? `research-summary-text research-recap ${className}`
          : "research-summary-text research-recap"
      }
    >
      Summary: {trimmed}
    </p>
  );
}

/** No placeholder or reserved space: mount only a completed, current recap. */
export default function ResearchRecap({
  content,
  onRegenerate,
}: {
  content: ResearchNodeContent;
  onRegenerate?: () => void;
}) {
  const { node, responseRevision } = content;
  const recap = node.recap;
  if (
    (node.kind ?? "run") !== "run" ||
    node.status !== "complete" ||
    !recap?.text.trim() ||
    !responseRevision ||
    recap.responseRevision !== responseRevision
  ) {
    return null;
  }
  if (!onRegenerate) {
    return <ResearchRecapLine text={recap.text} />;
  }
  return (
    <div
      className="research-recap-with-action"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRegenerate();
      }}
    >
      <ResearchRecapLine text={recap.text} />
      <button
        type="button"
        className="control-button research-recap-regenerate"
        title="Regenerate summary"
        aria-label="Regenerate summary"
        onClick={onRegenerate}
      >
        <RefreshCw size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
